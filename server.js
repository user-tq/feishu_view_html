require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { createCanvas } = require('canvas');
const echarts = require('echarts');
const axios = require('axios');

require('dotenv').config();

const FEISHU_CONFIG = {
    app_id: process.env.FEISHU_APP_ID || '',
    app_secret: process.env.FEISHU_APP_SECRET || '',
    tenant_access_token: process.env.FEISHU_TENANT_ACCESS_TOKEN || '',
    bitable_app_token: process.env.FEISHU_BITABLE_APP_TOKEN || '',
    table_id: process.env.FEISHU_TABLE_ID || '',
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
    const suffix = code.startsWith('6') || code.startsWith('9') ? 'sh' : 'sz';
    const symbol = suffix + code;
    const apiUrl = 'http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=' + symbol + '&scale=30&ma=no&datalen=240';
    const response = await axios.get(apiUrl, {
        timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' }
    });
    if (Array.isArray(response.data) && response.data.length > 0) {
        const allKlines = response.data.sort((a, b) => new Date(a.day) - new Date(b.day));
        const targetDate = new Date(date); targetDate.setHours(23,59,59,999);
        const fiveDaysAgo = new Date(targetDate.getTime() - 5*24*60*60*1000);
        const filtered = allKlines.filter(k => {
            const kd = new Date(k.day.split(' ')[0]);
            return kd >= fiveDaysAgo && kd <= targetDate;
        });
        if (filtered.length === 0) throw new Error('未找到 ' + date + ' 及其前5天的K线数据');
        return { klines: filtered };
    }
    throw new Error('未获取到K线数据');
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

async function generateKlinePNG(data, cost) {
    const { dates, ohlc, volumes } = data;
    const canvas = createCanvas(1200, 800);
    const chart = echarts.init(canvas, null, { renderer:'canvas' });
    await chart.setOption({
        backgroundColor:'#0d1117',
        title:{ text:'30 min k', left:'center', top:10, textStyle:{ color:'#e6edf3', fontSize:18 }},
        tooltip:{ trigger:'axis', axisPointer:{ type:'cross' }},
        grid:[{ left:'60', right:'40', top:'50', height:'55%' },{ left:'60', right:'40', top:'62%', height:'15%' }],
        xAxis:[
            { type:'category', data:dates, scale:true, boundaryGap:true, axisLine:{ lineStyle:{color:'#30363d'} }, splitLine:{show:false}, axisLabel:{color:'#8b949e', formatter:v=>v.split('-').slice(1).join('-')} },
            { type:'category', gridIndex:1, data:dates, axisLabel:{show:false} }
        ],
        yAxis:[
            { scale:true, splitArea:{show:true, areaStyle:{color:['rgba(13,17,23,0.3)','rgba(22,27,34,0.3)']}}, axisLine:{lineStyle:{color:'#30363d'}}, splitLine:{show:true,lineStyle:{color:'#21262d'}}, axisLabel:{color:'#8b949e'} },
            { gridIndex:1, splitNumber:2, axisLabel:{show:false}, splitLine:{show:false} }
        ],
        series:[
            { type:'candlestick', data:ohlc, itemStyle:{color:'#ef4444',color0:'#22c55e',borderColor:'#ef4444',borderColor0:'#22c55e'}, markLine:{ symbol:['none','none'], label:{show:true,position:'insideStartTop',color:'#fbbf24',backgroundColor:'rgba(13,17,23,0.8)',padding:[3,6]}, lineStyle:{color:'#fbbf24',type:'dashed',width:1.5}, data:[{yAxis:+cost.toFixed(2),label:{formatter:'cost '+cost}}] }},
            { type:'bar', xAxisIndex:1, yAxisIndex:1, data:volumes, barWidth:'60%' }
        ]
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

async function updateBitableRecord(recordId, fileToken) {
    const token = await getAccessToken();
    const url = 'https://open.feishu.cn/open-apis/bitable/v1/apps/' + FEISHU_CONFIG.bitable_app_token + '/tables/' + FEISHU_CONFIG.table_id + '/records/' + recordId;
    try {
        const response = await axios.put(url, {
            fields: { kline_chart: [{ file_token: fileToken }] }
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

app.get('/api/kline', async (req, res) => {
    var code = req.query.code;
    var date = req.query.date;
    if (!code || !date) {
        return res.status(400).json({ error: '缺少必要参数', required: ['code','date'] });
    }
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '股票代码格式不正确' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日期格式不正确' });
    try {
        var klineData = await fetchKlineData(code, date);
        return res.json({ success: true, code: code, date: date, klines: klineData.klines });
    } catch (error) {
        console.error('['+code+'] 获取K线数据失败:', error.message);
        return res.status(500).json({ success: false, error: error.message, code: code, date: date });
    }
});

app.get('/api/chart', async (req, res) => {
    var rid = req.query.record_id;
    var code = req.query.code;
    var date = req.query.date;
    var cost = req.query.cost;
    if (!rid || !code || !date || !cost) {
        return res.status(400).json({ error: '缺少必要参数', required: ['record_id','code','date','cost'] });
    }
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: '股票代码格式不正确' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '日期格式不正确' });
    if (isNaN(parseFloat(cost))) return res.status(400).json({ error: '买入价格必须为数字' });

    var buyCost = parseFloat(cost);
    var fileToken = null;
    try {
        console.log('['+code+'] 获取K线数据...');
        var klineData = await fetchKlineData(code, date);
        console.log('['+code+'] 获取到 '+klineData.klines.length+' 根K线');
        var parsedData = parseKlineData(klineData.klines);
        console.log('['+code+'] 生成K线图...');
        var pngBuffer = await generateKlinePNG(parsedData, buyCost);
        console.log('['+code+'] K线图生成成功，大小: '+pngBuffer.length+' bytes');
        var tmpFile = path.join(TMP_DIR, code+'_'+date+'_kline.png');
        fs.writeFileSync(tmpFile, pngBuffer);
        console.log('['+code+'] 上传到飞书...');
        fileToken = await uploadFileToFeishu(pngBuffer, code+'_'+date+'_kline.png');
        console.log('['+code+'] 文件上传成功，file_token: '+fileToken);
        console.log('['+code+'] 更新记录 '+rid+'...');
        await updateBitableRecord(rid, fileToken);
        console.log('['+code+'] 记录更新成功!');
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        return res.json({ success: true, message: 'K线图已生成并上传', record_id: rid, file_token: fileToken, klines_count: klineData.klines.length });
    } catch (error) {
        console.error('['+code+'] 处理失败:', error.message);
        var tf = path.join(TMP_DIR, code+'_'+date+'.png');
        if (fs.existsSync(tf)) fs.unlinkSync(tf);
        return res.status(500).json({ success: false, error: error.message, code: code, record_id: rid });
    }
});

app.get('/api/test', function(req, res) {
    res.json({ message: '飞书K线图服务运行正常', usage: '/api/chart?record_id=recXXXXX&code=600519&date=2024-01-15&cost=1800.50' });
});

app.get('/', function(req, res) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, function() {
    console.log('Server running on port ' + PORT);
    console.log('API: http://localhost:'+PORT+'/api/chart?record_id=recXXXXX&code=600519&date=2024-01-15&cost=1800.50');
});
