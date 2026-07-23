const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 前端页面路由
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 飞书自动化调用的API端点
// 飞书自动化流程会发送请求到此接口，传入股票代码和买入日期
app.get('/api/chart', (req, res) => {
    const { code, date } = req.query;
    
    // 验证参数
    if (!code || !date) {
        return res.status(400).json({ 
            error: '缺少必要参数',
            required: ['code (股票代码)', 'date (交易日期)'],
            example: '/api/chart?code=600519&date=2024-01-15'
        });
    }

    // 验证股票代码格式（简化验证）
    if (!/^\d{6}$/.test(code)) {
        return res.status(400).json({ 
            error: '股票代码格式不正确',
            format: '6位数字，如 600519'
        });
    }

    // 验证日期格式
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ 
            error: '日期格式不正确',
            format: 'YYYY-MM-DD，如 2024-01-15'
        });
    }

    // 重定向到K线图页面
    const redirectUrl = `/?code=${encodeURIComponent(code)}&date=${encodeURIComponent(date)}`;
    
    console.log(`[Redirect] ${code} @ ${date} -> ${redirectUrl}`);
    
    res.redirect(302, redirectUrl);
});

// API测试端点
app.get('/api/test', (req, res) => {
    res.json({
        message: '飞书中转服务运行正常',
        usage: {
            description: '飞书自动化触发此URL获取30分钟K线图',
            example: `/api/chart?code=600519&date=2024-01-15`
        },
        parameters: {
            code: '股票代码（6位数字，如 600519）',
            date: '交易日期（格式 YYYY-MM-DD）'
        },
        redirect_example: '/?code=600519&date=2024-01-15'
    });
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`  飞书K线图中转服务已启动`);
    console.log(`  访问地址: http://localhost:${PORT}`);
    console.log(`  API端点: http://localhost:${PORT}/api/chart`);
    console.log(`  测试端点: http://localhost:${PORT}/api/test`);
    console.log(`========================================`);
    console.log(`\n示例URL:`);
    console.log(`  http://localhost:${PORT}/api/chart?code=600519&date=2024-01-15`);
    console.log(`  ↓ 会跳转到`);
    console.log(`  http://localhost:${PORT}/?code=600519&date=2024-01-15`);
    console.log(`\n在飞书多维表格的「按钮」字段中配置:`);
    console.log(`  URL: http://your-domain.com/api/chart?code={{股票代码}}&date={{买入日期}}`);
});
