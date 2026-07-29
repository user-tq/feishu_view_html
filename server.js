require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { createCanvas, GlobalFonts } = require('canvas');
const echarts = require('echarts');
const axios = require('axios');

require('dotenv').config();

// 注册中文字体，解决 Railway/Linux 环境下 node-canvas 中文显示为方块的问题
const CJK_FONT_PATHS = [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
];
const CJK_FONT_FAMILY = 'Noto Sans CJK SC';
let cjkFontRegistered = false;
for (const fp of CJK_FONT_PATHS) {
    if (fs.existsSync(fp)) {
        try {
            GlobalFonts.registerFromPath(fp, CJK_FONT_FAMILY);
            cjkFontRegistered = true;
            console.log('[Font] Registered CJK font:', fp);
        } catch (e) {
            console.warn('[Font] Failed to register:', fp, e.message);
        }
        break;
    }
}
if (!cjkFontRegistered) console.warn('[Font] No CJK font found, Chinese may render as squares');
const FONT_FAMILY = cjkFontRegistered ? CJK_FONT_FAMILY : 'sans-serif';

const FEISHU_CONFIG = {
    app_id: process.env.FEISHU_APP_ID || '',
    app_secret: process.env.FEISHU_APP_SECRET || '',
    tenant_access_token: process.env.FEISHU_TENANT_ACCESS_TOKEN || '',
    bitable_app_token: process.env.FEISHU_BITABLE_APP_TOKEN || '',
    table_id: process.env.FEISHU_TABLE_ID || '',
    period_high_field: process.env.PERIOD_HIGH_FIELD || '期间价',
    _token_expiry: 0,
};

const REQUIRED_ENVS = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BITABLE_APP_TOKEN', 'FEISHU_TABLE_ID'];
const missingEnvs = REQUIRED_ENVS.filter(k => !process.env[k]);
if (missingEnvs.length > 0) {
    console.error('缺少必要环境变量:', missingEnvs.join(', '));
    process.exit(1);
}

const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

async function getAccessToken() {
    if (Date.now() < (FEISHU_CONFIG._token_expiry - 300000)) return FEISHU_CONFIG.tenant_access_token;
    try {
        const r = await axios.post(
            'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
            { app_id: FEISHU_CONFIG.app_id, app_secret: FEISHU_CONFIG.app_secret },
            { timeout: 10000 }
        );
        if (r.data.code === 0) {
            FEISHU_CONFIG.tenant_access_token = r.data.tenant_access_token;
            FEISHU_CONFIG._token_expiry = Date.now() + (r.data.expire * 1000);
            console.log('[Token] Refreshed');
            return FEISHU_CONFIG.tenant_access_token;
        }
    } catch (e) { console.error('[Token] Refresh failed'); }
    return FEISHU_CONFIG.tenant_access_token;
}

async function fetchKlineData(code, date) {
    const isShanghai = code.startsWith('6') || code.startsWith('9') || code.startsWith('5');
    const suffix = isShanghai ? 'sh' : 'sz';
    const symbol = suffix + code;

    // 动态计算 datalen：根据输入日期距今天的天数，确保数据覆盖输入日期
    // 每天 8 根 30 分钟线，按 5/7 比例估算交易日，加 80 根缓冲（覆盖前 5 个交易日 + 节假日）
    const today = new Date();
    const inputDate = new Date(date);
    const calendarDaysDiff = Math.max(1, Math.ceil((today - inputDate) / (24 * 60 * 60 * 1000)));
    const estimatedBars = Math.ceil(calendarDaysDiff * 5 / 7 * 8) + 80;
    const datalen = Math.min(Math.max(estimatedBars, 240), 3000);

    const apiUrl = 'http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=' + symbol + '&scale=30&ma=no&datalen=' + datalen;
    const response = await axios.get(apiUrl, {
        timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' }
    });
    if (!Array.isArray(response.data) || response.data.length === 0) {
        throw new Error('未获取到K线数据');
    }

    const allKlines = response.data.sort((a, b) => new Date(a.day) - new Date(b.day));

    // 提取所有交易日（去重排序）
    const allDates = [...new Set(allKlines.map(k => k.day.split(' ')[0]))].sort();

    // 定位目标交易日：输入日期当天，若为非交易日则取最近的之前交易日
    let targetDateStr = date;
    if (!allDates.includes(targetDateStr)) {
        const earlierDates = allDates.filter(d => d <= targetDateStr);
        if (earlierDates.length === 0) {
            throw new Error('未找到 ' + date + ' 及其之前的交易日K线数据');
        }
        targetDateStr = earlierDates[earlierDates.length - 1];
    }

    // 取目标交易日及其前 5 个交易日（共 6 个交易日），并严格排除超出目标日期的K柱
    const targetIdx = allDates.indexOf(targetDateStr);
    const startIdx = Math.max(0, targetIdx - 5);
    const selectedDates = new Set(allDates.slice(startIdx, targetIdx + 1));

    const filtered = allKlines.filter(k => {
        const d = k.day.split(' ')[0];
        return selectedDates.has(d) && d <= targetDateStr;
    });

    if (filtered.length === 0) {
        throw new Error('未找到 ' + date + ' 及其前5个交易日的K线数据');
    }

    return { klines: filtered, targetDate: targetDateStr };
}

async function fetchDailyKlineData(code, date, priorDays = 49) {
    const isShanghai = code.startsWith('6') || code.startsWith('9') || code.startsWith('5');
    const suffix = isShanghai ? 'sh' : 'sz';
    const symbol = suffix + code;

    // 动态计算 datalen：确保覆盖输入日期及其前 priorDays 个交易日
    // 按 5/7 比例估算交易日，加 30 根缓冲（覆盖节假日）
    const today = new Date();
    const inputDate = new Date(date);
    const calendarDaysDiff = Math.max(1, Math.ceil((today - inputDate) / (24 * 60 * 60 * 1000)));
    const estimatedBars = Math.ceil(calendarDaysDiff * 5 / 7) + priorDays + 30;
    const datalen = Math.min(Math.max(estimatedBars, 60), 3000);

    const apiUrl = 'http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=' + symbol + '&scale=240&ma=no&datalen=' + datalen;
    const response = await axios.get(apiUrl, {
        timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' }
    });
    if (!Array.isArray(response.data) || response.data.length === 0) {
        throw new Error('未获取到日线数据');
    }

    const allKlines = response.data.sort((a, b) => new Date(a.day) - new Date(b.day));
    const allDates = [...new Set(allKlines.map(k => k.day.split(' ')[0]))].sort();

    let targetDateStr = date;
    if (!allDates.includes(targetDateStr)) {
        const earlierDates = allDates.filter(d => d <= targetDateStr);
        if (earlierDates.length === 0) {
            throw new Error('未找到 ' + date + ' 及其之前的交易日日线数据');
        }
        targetDateStr = earlierDates[earlierDates.length - 1];
    }

    const targetIdx = allDates.indexOf(targetDateStr);
    const startIdx = Math.max(0, targetIdx - priorDays);
    const selectedDates = new Set(allDates.slice(startIdx, targetIdx + 1));

    const filtered = allKlines.filter(k => {
        const d = k.day.split(' ')[0];
        return selectedDates.has(d) && d <= targetDateStr;
    });

    if (filtered.length === 0) {
        throw new Error('未找到 ' + date + ' 及其前' + priorDays + '个交易日的日线数据');
    }

    return { klines: filtered, targetDate: targetDateStr };
}

async function fetchHighestPriceInRange(code, buyDate, sellDate) {
    const isShanghai = code.startsWith('6') || code.startsWith('9') || code.startsWith('5');
    const suffix = isShanghai ? 'sh' : 'sz';
    const symbol = suffix + code;

    const today = new Date();
    const calendarDaysDiff = Math.max(1, Math.ceil((today - new Date(buyDate)) / (24 * 60 * 60 * 1000)));
    const datalen = Math.min(Math.max(calendarDaysDiff + 30, 60), 1000);

    const apiUrl = 'http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=' + symbol + '&scale=240&ma=no&datalen=' + datalen;
    const response = await axios.get(apiUrl, {
        timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' }
    });
    if (!Array.isArray(response.data) || response.data.length === 0) {
        throw new Error('未获取到日线数据');
    }

    const allKlines = response.data.sort((a, b) => new Date(a.day) - new Date(b.day));
    const allDates = [...new Set(allKlines.map(k => k.day.split(' ')[0]))].sort();

    let adjustedBuyDate = buyDate;
    if (!allDates.includes(adjustedBuyDate)) {
        const laterDates = allDates.filter(d => d >= adjustedBuyDate);
        if (laterDates.length === 0) {
            throw new Error('未找到 ' + buyDate + ' 之后的交易日K线数据');
        }
        adjustedBuyDate = laterDates[0];
    }

    let adjustedSellDate = sellDate;
    const sellDateObj = new Date(sellDate);
    if (sellDateObj > today) {
        adjustedSellDate = allDates[allDates.length - 1];
    } else if (!allDates.includes(adjustedSellDate)) {
        const earlierDates = allDates.filter(d => d <= adjustedSellDate);
        if (earlierDates.length === 0) {
            throw new Error('未找到 ' + sellDate + ' 之前的交易日K线数据');
        }
        adjustedSellDate = earlierDates[earlierDates.length - 1];
    }

    const filtered = allKlines.filter(k => {
        const d = k.day.split(' ')[0];
        return d >= adjustedBuyDate && d <= adjustedSellDate;
    });

    if (filtered.length === 0) {
        throw new Error('未找到 ' + buyDate + ' 至 ' + sellDate + ' 期间的K线数据');
    }

    const highestPrice = Math.max(...filtered.map(k => parseFloat(k.high)));
    const actualDates = [...new Set(filtered.map(k => k.day.split(' ')[0]))].sort();

    const warnings = [];
    if (adjustedBuyDate !== buyDate) {
        const gapDays = Math.ceil((new Date(adjustedBuyDate) - new Date(buyDate)) / (24 * 60 * 60 * 1000));
        if (gapDays > 7) {
            warnings.push('买入日期 ' + buyDate + ' 为非交易日，实际起始交易日为 ' + adjustedBuyDate + '，间隔 ' + gapDays + ' 天');
        }
    }
    if (adjustedSellDate !== sellDate && sellDateObj <= today) {
        const gapDays = Math.ceil((new Date(sellDate) - new Date(adjustedSellDate)) / (24 * 60 * 60 * 1000));
        if (gapDays > 7) {
            warnings.push('卖出日期 ' + sellDate + ' 为非交易日，实际结束交易日为 ' + adjustedSellDate + '，间隔 ' + gapDays + ' 天');
        }
    }
    if (sellDateObj > today) {
        warnings.push('卖出日期 ' + sellDate + ' 在未来，数据仅覆盖至最新交易日 ' + adjustedSellDate);
    }

    const earliestDate = actualDates[0];
    const earliestGapDays = Math.ceil((new Date(earliestDate) - new Date(adjustedBuyDate)) / (24 * 60 * 60 * 1000));
    if (earliestGapDays > 10) {
        warnings.push('可能因数据长度限制导致早期数据缺失，实际起始交易日为 ' + earliestDate + '，与买入日期差距 ' + earliestGapDays + ' 天');
    }

    return { highestPrice, actualDates, count: filtered.length, adjustedBuyDate, adjustedSellDate, warnings, partialCoverage: sellDateObj > today };
}

function parseKlineData(klines) {
    const dates = [], ohlc = [], volumes = [];
    klines.forEach(k => {
        const o=+k.open, c=+k.close, h=+k.high, l=+k.low;
        dates.push(k.day.split(' ')[0]);
        ohlc.push([o, c, l, h]);
        volumes.push({ value:+k.volume, itemStyle:{ color:c>=o?'rgba(239,68,68,0.8)':'rgba(34,197,94,0.8)' }});
    });
    return { dates, ohlc, volumes };
}

function calculateMA(closes, period) {
    var ma = [];
    for (var i = 0; i < closes.length; i++) {
        if (i < period - 1) {
            ma.push(null);
        } else {
            var sum = 0;
            for (var j = i - period + 1; j <= i; j++) sum += closes[j];
            ma.push(+(sum / period).toFixed(2));
        }
    }
    return ma;
}

async function generateKlinePNG(data, cost, code, date, title, maData) {
    const { dates, ohlc, volumes } = data;
    const canvas = createCanvas(1200, 800);
    const chart = echarts.init(canvas, null, { renderer:'canvas' });

    var series = [
        { type:'candlestick', data:ohlc, itemStyle:{color:'#ef4444',color0:'#22c55e',borderColor:'#ef4444',borderColor0:'#22c55e'}, markLine:{ symbol:['none','none'], label:{show:true,position:'insideStartTop',color:'#fbbf24',backgroundColor:'rgba(13,17,23,0.8)',padding:[3,6],fontFamily:FONT_FAMILY}, lineStyle:{color:'#fbbf24',type:'dashed',width:1.5}, data:[{yAxis:+cost.toFixed(2),label:{formatter:'成本 '+cost}}] }},
        { type:'bar', xAxisIndex:1, yAxisIndex:1, data:volumes, barWidth:'60%' }
    ];
    if (maData && maData.length > 0) {
        maData.forEach(function(ma) {
            series.push({
                type:'line', data:ma.data, smooth:true, symbol:'none',
                lineStyle:{ color:ma.color, width:1.5 }, name:ma.name, z:5,
                emphasis: { focus: 'series' },
                label: { show: false }
            });
        });
    }

    await chart.setOption({
        backgroundColor:'#0d1117',
        title:{ text: title || (code + ' ' + date + ' 30分K'), left:'center', top:10, textStyle:{ color:'#e6edf3', fontSize:18, fontFamily:FONT_FAMILY }},
        tooltip:{ trigger:'axis', axisPointer:{ type:'cross' }},
        legend: maData && maData.length > 0 ? {
            data: maData.map(function(m){ return m.name; }),
            textStyle:{ color:'#8b949e', fontFamily:FONT_FAMILY, fontSize:11 },
            top:36, right:50, itemWidth:14, itemHeight:8
        } : undefined,
        grid:[{ left:'60', right:'40', top: maData ? '60' : '50', height: maData ? '50%' : '55%' },{ left:'60', right:'40', top:'68%', height:'13%' }],
        xAxis:[
            { type:'category', data:dates, scale:true, boundaryGap:true, axisLine:{ lineStyle:{color:'#30363d'} }, splitLine:{show:false}, axisLabel:{color:'#8b949e', fontFamily:FONT_FAMILY, formatter:v=>v.split('-').slice(1).join('-')} },
            { type:'category', gridIndex:1, data:dates, axisLabel:{show:false} }
        ],
        yAxis:[
            { scale:true, splitArea:{show:true, areaStyle:{color:['rgba(13,17,23,0.3)','rgba(22,27,34,0.3)']}}, axisLine:{lineStyle:{color:'#30363d'}}, splitLine:{show:true,lineStyle:{color:'#21262d'}}, axisLabel:{color:'#8b949e', fontFamily:FONT_FAMILY} },
            { gridIndex:1, splitNumber:2, axisLabel:{show:false}, splitLine:{show:false} }
        ],
        series: series
    });
    const buf = chart.getZr().dom.toBuffer('image/png', { compressionLevel: 9 });
    chart.dispose();
    if (buf.length > 2 * 1024 * 1024) {
        throw new Error('生成的 PNG 超过 2MB，请减少数据量或降低分辨率');
    }
    return buf;
}

async function uploadFileToFeishu(fileBuffer, filename) {
    const token = await getAccessToken();
    const form = require('form-data');
    const formData = new form();
    formData.append('file_name', filename);
    formData.append('parent_type', 'bitable_image');
    formData.append('parent_node', FEISHU_CONFIG.bitable_app_token);
    formData.append('size', String(fileBuffer.length));
    formData.append('extra', JSON.stringify({ drive_route_token: FEISHU_CONFIG.bitable_app_token }));
    formData.append('file', fileBuffer, { filename, contentType: 'image/png' });
    try {
        const response = await axios.post(
            'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
            formData,
            { headers: { Authorization: 'Bearer '+token, ...formData.getHeaders() }, timeout: 30000 }
        );
        if (response.data && response.data.code === 0 && response.data.data && response.data.data.file_token) {
            return response.data.data.file_token;
        }
        throw new Error('上传失败: ' + JSON.stringify(response.data));
    } catch (error) {
        console.error('[上传文件失败] 状态:', error.response?.status);
        console.error('[上传文件失败] 响应:', JSON.stringify(error.response?.data));
        throw error;
    }
}

async function updateBitableRecord(recordId, fileTokens) {
    const token = await getAccessToken();
    const url = 'https://open.feishu.cn/open-apis/bitable/v1/apps/' + FEISHU_CONFIG.bitable_app_token + '/tables/' + FEISHU_CONFIG.table_id + '/records/' + recordId;
    const tokens = Array.isArray(fileTokens) ? fileTokens : [fileTokens];
    try {
        const response = await axios.put(url, {
            fields: { kline_chart: tokens.map(t => ({ file_token: t })) }
        }, {
            headers: { Authorization: 'Bearer '+token, 'Content-Type': 'application/json' },
            timeout: 30000
        });
        if (response.data && response.data.code === 0) return response.data.data;
        throw new Error(response.data.msg || '更新记录失败');
    } catch (error) {
        console.error('更新飞书记录失败:', error.response?.data || error.message);
        throw new Error('更新记录失败: ' + (error.response?.data?.msg || error.message));
    }
}

async function updateBitableField(recordId, fieldName, fieldValue) {
    const token = await getAccessToken();
    const url = 'https://open.feishu.cn/open-apis/bitable/v1/apps/' + FEISHU_CONFIG.bitable_app_token + '/tables/' + FEISHU_CONFIG.table_id + '/records/' + recordId;
    try {
        const response = await axios.put(url, {
            fields: { [fieldName]: fieldValue }
        }, {
            headers: { Authorization: 'Bearer '+token, 'Content-Type': 'application/json' },
            timeout: 30000
        });
        if (response.data && response.data.code === 0) return response.data.data;
        throw new Error(response.data.msg || '更新字段失败');
    } catch (error) {
        console.error('更新字段失败:', error.response?.data || error.message);
        throw new Error('更新字段失败: ' + (error.response?.data?.msg || error.message));
    }
}

app.get('/api/kline', async (req, res) => {
    var code = req.query.code;
    var date = req.query.date;
    console.log('[API /api/kline] 入参: code=' + code + ', date=' + date);
    if (!code || !date) {
        return res.status(400).json({ error: '缺少必要参数', required: ['code','date'] });
    }
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '股票代码格式不正确' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日期格式不正确' });
    try {
        var klineData = await fetchKlineData(code, date);
        return res.json({ success: true, code: code, date: date, targetDate: klineData.targetDate, klines: klineData.klines });
    } catch (error) {
        console.error('['+code+'] 获取K线数据失败:', error.message);
        return res.status(500).json({ success: false, error: error.message, code: code, date: date });
    }
});

app.get('/api/daily-kline', async (req, res) => {
    var code = req.query.code;
    var date = req.query.date;
    var priorDays = parseInt(req.query.prior_days) || 49;
    var withMA = req.query.ma === '1';
    console.log('[API /api/daily-kline] 入参: code=' + code + ', date=' + date + ', prior_days=' + priorDays + ', ma=' + withMA);
    if (!code || !date) {
        return res.status(400).json({ error: '缺少必要参数', required: ['code','date'] });
    }
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '股票代码格式不正确' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日期格式不正确' });
    try {
        // 如果需要MA，多取200根用于计算MA200
        var fetchDays = withMA ? priorDays + 200 : priorDays;
        var klineData = await fetchDailyKlineData(code, date, fetchDays);
        var klines = klineData.klines;

        var ma = undefined;
        if (withMA) {
            var parsed = parseKlineData(klines);
            var closes = parsed.ohlc.map(function(x){ return x[1]; });
            var ma50 = calculateMA(closes, 50);
            var ma150 = calculateMA(closes, 150);
            var ma200 = calculateMA(closes, 200);
            // 截取展示范围（最后 priorDays+1 根）
            var startIdx = klines.length - (priorDays + 1);
            ma = {
                MA50: ma50.slice(startIdx),
                MA150: ma150.slice(startIdx),
                MA200: ma200.slice(startIdx)
            };
            klines = klines.slice(startIdx);
        }

        return res.json({ success: true, code: code, date: date, targetDate: klineData.targetDate, klines: klines, ma: ma });
    } catch (error) {
        console.error('['+code+'] 获取日线数据失败:', error.message);
        return res.status(500).json({ success: false, error: error.message, code: code, date: date });
    }
});

app.get('/api/chart', async (req, res) => {
    var rid = req.query.record_id;
    var code = req.query.code;
    var date = req.query.date;
    var cost = req.query.cost;
    console.log('[API /api/chart] 入参: record_id=' + rid + ', code=' + code + ', date=' + date + ', cost=' + cost);
    if (!rid || !code || !date || !cost) {
        return res.status(400).json({ error: '缺少必要参数', required: ['record_id','code','date','cost'] });
    }
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '股票代码格式不正确' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日期格式不正确' });
    if (isNaN(parseFloat(cost))) return res.status(400).json({ error: '买入价格必须为数字' });

    var buyCost = parseFloat(cost);
    var tmpFiles = [];
    try {
        // 并行获取30分钟和日线K线数据（日线多取200根用于计算MA200）
        console.log('['+code+'] 获取30分钟和日线K线数据...');
        var [klineData30m, klineDataDailyAll] = await Promise.all([
            fetchKlineData(code, date),
            fetchDailyKlineData(code, date, 249)
        ]);
        console.log('['+code+'] 获取到 30分钟K线 '+klineData30m.klines.length+' 根, 日线(含MA前置) '+klineDataDailyAll.klines.length+' 根');

        var parsed30m = parseKlineData(klineData30m.klines);
        var parsedDailyAll = parseKlineData(klineDataDailyAll.klines);

        // 用全量日线数据计算 MA50/MA150/MA200，再截取最后50根用于展示
        var closesAll = parsedDailyAll.ohlc.map(function(x){ return x[1]; });
        var ma50All = calculateMA(closesAll, 50);
        var ma150All = calculateMA(closesAll, 150);
        var ma200All = calculateMA(closesAll, 200);
        var displayCount = 50;
        var startIdx = parsedDailyAll.dates.length - displayCount;
        var parsedDaily = {
            dates: parsedDailyAll.dates.slice(startIdx),
            ohlc: parsedDailyAll.ohlc.slice(startIdx),
            volumes: parsedDailyAll.volumes.slice(startIdx)
        };
        var maData = [
            { name:'MA50',  data: ma50All.slice(startIdx),  color:'#f59e0b' },
            { name:'MA150', data: ma150All.slice(startIdx), color:'#c084fc' },
            { name:'MA200', data: ma200All.slice(startIdx), color:'#60a5fa' }
        ];
        console.log('['+code+'] 日线展示 '+parsedDaily.dates.length+' 根, MA50/150/200 已计算');

        // 顺序生成两张K线图（并发会导致 node-canvas 字体渲染冲突，中文变方块）
        console.log('['+code+'] 生成30分K线图...');
        var png30m = await generateKlinePNG(parsed30m, buyCost, code, date, code + ' ' + date + ' 30分K');
        console.log('['+code+'] 生成日K线图（含MA均线）...');
        var pngDaily = await generateKlinePNG(parsedDaily, buyCost, code, date, code + ' ' + date + ' 日K', maData);
        console.log('['+code+'] 30分K图 '+png30m.length+' bytes, 日K图 '+pngDaily.length+' bytes');

        var tmp30m = path.join(TMP_DIR, code+'_'+date+'_30m_kline.png');
        var tmpDaily = path.join(TMP_DIR, code+'_'+date+'_daily_kline.png');
        fs.writeFileSync(tmp30m, png30m);
        fs.writeFileSync(tmpDaily, pngDaily);
        tmpFiles.push(tmp30m, tmpDaily);

        // 上传两张图到飞书
        console.log('['+code+'] 上传到飞书...');
        var [token30m, tokenDaily] = await Promise.all([
            uploadFileToFeishu(png30m, code+'_'+date+'_30m_kline.png'),
            uploadFileToFeishu(pngDaily, code+'_'+date+'_daily_kline.png')
        ]);
        console.log('['+code+'] 文件上传成功, 30分K token: '+token30m+', 日K token: '+tokenDaily);

        // 更新记录（两张图作为附件）
        console.log('['+code+'] 更新记录 '+rid+'...');
        await updateBitableRecord(rid, [token30m, tokenDaily]);
        console.log('['+code+'] 记录更新成功!');

        tmpFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        return res.json({
            success: true,
            message: '日线和30分钟K线图已生成并上传',
            record_id: rid,
            file_tokens: [token30m, tokenDaily],
            klines_30m_count: klineData30m.klines.length,
            klines_daily_count: klineDataDaily.klines.length
        });
    } catch (error) {
        console.error('['+code+'] 处理失败:', error.message);
        tmpFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        return res.status(500).json({ success: false, error: error.message, code: code, record_id: rid });
    }
});

app.get('/api/period-high', async (req, res) => {
    var rid = req.query.record_id;
    var code = req.query.code;
    var buyDate = req.query.buy_date;
    var sellDate = req.query.sell_date;
    console.log('[API /api/period-high] 入参: record_id=' + rid + ', code=' + code + ', buy_date=' + buyDate + ', sell_date=' + sellDate);
    if (!rid || !code || !buyDate || !sellDate) {
        return res.status(400).json({ error: '缺少必要参数', required: ['record_id','code','buy_date','sell_date'] });
    }
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '股票代码格式不正确' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(buyDate)) return res.status(400).json({ error: '买入日期格式不正确' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sellDate)) return res.status(400).json({ error: '卖出日期格式不正确' });
    if (new Date(buyDate) > new Date(sellDate)) return res.status(400).json({ error: '买入日期不能晚于卖出日期' });

    try {
        console.log('['+code+'] 获取 '+buyDate+' 至 '+sellDate+' 期间最高价...');
        var result = await fetchHighestPriceInRange(code, buyDate, sellDate);
        console.log('['+code+'] 期间最高价: '+result.highestPrice+', 实际交易日: '+result.actualDates.join(', '));
        if (result.warnings.length > 0) {
            console.warn('['+code+'] 警告:', result.warnings);
        }

        var fieldValue = parseFloat(result.highestPrice.toFixed(2));
        var fieldName = FEISHU_CONFIG.period_high_field;
        console.log('['+code+'] 更新记录 '+rid+' 的 ['+fieldName+'] 字段为: '+fieldValue);
        await updateBitableField(rid, fieldName, fieldValue);
        console.log('['+code+'] 记录更新成功!');

        return res.json({
            success: true,
            record_id: rid,
            code: code,
            buy_date: buyDate,
            sell_date: sellDate,
            adjusted_buy_date: result.adjustedBuyDate,
            adjusted_sell_date: result.adjustedSellDate,
            highest_price: fieldValue,
            actual_trading_dates: result.actualDates,
            trading_days_count: result.count,
            partial_coverage: result.partialCoverage,
            warnings: result.warnings
        });
    } catch (error) {
        console.error('['+code+'] 处理失败:', error.message);
        return res.status(500).json({ success: false, error: error.message, code: code, record_id: rid });
    }
});

app.get('/api/test', function(req, res) {
    res.json({ message: '飞书K线图服务运行正常', usage: '/api/chart?record_id=recXXXXX&code=600519&date=2024-01-15&cost=1800.50 (生成日线+30分钟K线图), /api/kline?code=600519&date=2024-01-15 (30分钟K线数据), /api/daily-kline?code=600519&date=2024-01-15 (日线数据), /api/period-high?record_id=recXXXXX&code=600519&buy_date=2024-01-01&sell_date=2024-03-31' });
});

app.get('/', function(req, res) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, function() {
    console.log('Server running on port ' + PORT);
    console.log('API: http://localhost:'+PORT+'/api/chart?record_id=recXXXXX&code=600519&date=2024-01-15&cost=1800.50');
    console.log('API: http://localhost:'+PORT+'/api/period-high?record_id=recXXXXX&code=600519&buy_date=2024-01-01&sell_date=2024-03-31');
});
