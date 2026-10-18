# FastAPI + AkShare 数据服务

## 职责

**只做数据获取与规整**，不做策略、回测、交易。
这些计算在客户端 Rust 核心中完成，因此本服务可以被 Linux / Windows / Android 三端共用。

## 目录

```
backend/
├── requirements.txt
└── app/
    ├── main.py               # FastAPI 入口，/health、/
    ├── schemas.py            # Pydantic 模型（与前端 types.ts 一一对应）
    ├── core/config.py        # 环境变量配置（前缀 QBOT_）
    ├── api/
    │   ├── deps.py           # DataSourceError -> 502
    │   └── v1/
    │       ├── stocks.py     # A股：列表 / 实时行情 / 历史K线
    │       └── funds.py      # 基金：名录 / 单位净值
    └── services/
        └── akshare_service.py # AkShare 取数与列名映射
```

## 启动

```bash
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

- 接口文档：http://127.0.0.1:8000/docs
- 健康检查：http://127.0.0.1:8000/health

## 接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（含 AkShare 可用性） |
| GET | `/api/v1/stocks?keyword=&limit=` | A股列表，支持代码/名称过滤 |
| GET | `/api/v1/stocks/quotes?symbols=600519,000001` | 批量实时行情（最多 100） |
| GET | `/api/v1/stocks/kline?symbol=&period=&adjust=&start=&end=` | 历史K线，period: daily/weekly/monthly，adjust: none/qfq/hfq |
| GET | `/api/v1/funds?keyword=&limit=` | 基金名录 |
| GET | `/api/v1/funds/nav?code=&start=&end=` | 基金单位净值序列 |

## 配置

通过环境变量（前缀 `QBOT_`）或 `backend/.env` 覆盖：

```env
QBOT_HOST=0.0.0.0
QBOT_PORT=8000
QBOT_AKSHARE_RETRIES=2
QBOT_REQUEST_TIMEOUT=20
```

## 注意事项

1. **AkShare 延迟导入**：首次取数时才 import，服务启动更快，健康检查也更灵敏。
2. **列名映射集中管理**：AkShare 不同版本列名会变化，所有映射都在 `akshare_service.py`，不泄漏到路由层。
3. **数据源异常返回 502**：语义上明确是上游问题，前端可据此提示「数据源暂不可用」。
4. **Android 访问**：手机端需把后端地址改为电脑局域网 IP，例如 `http://192.168.1.10:8000`；同时确认防火墙放行该端口。
5. **接口限流**：AkShare 直连东方财富等公开接口，短时间内大量请求可能被限制。生产使用建议加缓存或改为盘后批量落库。
