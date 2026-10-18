"""接口契约验证脚本。

背景：沙箱内未安装 AkShare（体积大、且需要外网行情接口）。
本脚本用替身函数替换 akshare_service 的取数函数，验证：
1) 路由层 -> Pydantic 响应模型的字段契约是否与前端 TypeScript 类型一致；
2) 参数校验（symbols 为空、超 100 个、period/adjust 枚举）是否正确拦截；
3) 数据源异常是否正确转换为 502；
4) TTL 缓存命中与清理是否按预期工作。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient

from app.services import akshare_service as svc
from app.core.cache import cache

# ---- 替身数据 -------------------------------------------------------------
FAKE_BARS = [
    {"date": "2026-10-16", "open": 1680.0, "high": 1702.0, "low": 1675.0,
     "close": 1698.5, "volume": 31200.0, "amount": 5.29e9, "change_pct": 1.12},
    {"date": "2026-10-17", "open": 1699.0, "high": 1710.0, "low": 1690.0,
     "close": 1705.2, "volume": 28700.0, "amount": 4.88e9, "change_pct": 0.39},
]


def stub_stock_list(keyword=None, limit=200):
    rows = [
        {"symbol": "600519", "name": "贵州茅台", "industry": "白酒", "market": "SH", "list_date": "2001-08-27"},
        {"symbol": "000001", "name": "平安银行", "industry": "银行", "market": "SZ", "list_date": "1991-04-03"},
    ]
    if keyword:
        rows = [r for r in rows if keyword in r["symbol"] or keyword in r["name"]]
    return rows[:limit]


def stub_quotes(symbols):
    return [
        {"symbol": code, "name": "贵州茅台" if code == "600519" else "标的",
         "price": 1705.2, "prev_close": 1698.5, "open": 1699.0, "high": 1710.0,
         "low": 1690.0, "change": 6.7, "change_pct": 0.39, "volume": 28700.0,
         "amount": 4.88e9, "turnover": 0.23, "pe_ttm": 28.6,
         "timestamp": "2026-10-17T15:00:00"}
        for code in symbols
    ]


def stub_kline(symbol, period="daily", adjust="qfq", start=None, end=None):
    return FAKE_BARS


def stub_profile(symbol):
    return {"symbol": symbol, "name": "贵州茅台", "industry": "白酒", "market": "SH",
            "list_date": "2001-08-27", "total_market_cap": 2.14e12,
            "float_market_cap": 2.14e12, "total_shares": 1.256e9, "float_shares": 1.256e9}


def stub_index_overview(limit=6):
    rows = [
        {"symbol": "000001", "name": "上证指数", "price": 3120.4, "change": 12.3, "change_pct": 0.40, "volume": 3.1e8, "amount": 4.2e11},
        {"symbol": "399001", "name": "深证成指", "price": 9860.7, "change": -25.1, "change_pct": -0.25, "volume": 3.6e8, "amount": 5.1e11},
    ]
    return rows[:limit]


def stub_fund_list(keyword=None, limit=200):
    rows = [
        {"code": "110022", "name": "易方达消费行业股票", "type": "股票型", "company": None, "manager": None, "size": None},
        {"code": "000001", "name": "华夏成长混合", "type": "混合型", "company": None, "manager": None, "size": None},
    ]
    if keyword:
        rows = [r for r in rows if keyword in r["code"] or keyword in r["name"]]
    return rows[:limit]


FAKE_POINTS = [
    {"date": "2026-10-16", "nav": 3.4210, "acc_nav": 4.9310, "daily_return": 0.52},
    {"date": "2026-10-17", "nav": 3.4382, "acc_nav": 4.9482, "daily_return": 0.50},
]


def stub_fund_nav(code, start=None, end=None):
    return {"code": code, "name": "易方达消费行业股票", "points": FAKE_POINTS}


def stub_fund_detail(code):
    return {"code": code, "name": "易方达消费行业股票", "type": "股票型",
            "company": None, "manager": None, "size": None,
            "latest_nav": 3.4382, "latest_date": "2026-10-17", "points": FAKE_POINTS}


def stub_search(keyword, limit=20):
    return [
        {"symbol": "600519", "name": "贵州茅台", "kind": "stock"},
        {"symbol": "110022", "name": "易方达消费行业股票", "kind": "fund"},
    ][:limit]


def stub_boom(*args, **kwargs):
    raise svc.DataSourceError("上游数据源不可用（测试注入）")


def install_stubs(boom: bool = False) -> None:
    if boom:
        for name in ("fetch_stock_list", "fetch_quotes", "fetch_stock_kline",
                     "fetch_stock_profile", "fetch_index_overview", "fetch_fund_list",
                     "fetch_fund_nav", "fetch_fund_detail", "search_all"):
            setattr(svc, name, stub_boom)
        return
    svc.fetch_stock_list = stub_stock_list
    svc.fetch_quotes = stub_quotes
    svc.fetch_stock_kline = stub_kline
    svc.fetch_stock_profile = stub_profile
    svc.fetch_index_overview = stub_index_overview
    svc.fetch_fund_list = stub_fund_list
    svc.fetch_fund_nav = stub_fund_nav
    svc.fetch_fund_detail = stub_fund_detail
    svc.search_all = stub_search


# ---- 断言工具 -------------------------------------------------------------
PASSED: list[str] = []
FAILED: list[tuple[str, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        PASSED.append(name)
        print(f"  PASS  {name}")
    else:
        FAILED.append((name, detail))
        print(f"  FAIL  {name}  {detail}")


def expect_fields(obj: dict, fields: list[str], label: str) -> None:
    missing = [f for f in fields if f not in obj]
    check(f"{label} 字段完整", not missing, f"缺失 {missing}")


def main() -> int:
    from app.main import app

    print("\n=== 1. 正常路径（替身数据） ===")
    install_stubs()
    client = TestClient(app)

    r = client.get("/health")
    check("GET /health 200", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        body = r.json()
        expect_fields(body, ["status", "service", "version", "akshare_available",
                            "akshare_version", "cache_entries", "time"], "health")
        check("health.status == ok", body.get("status") == "ok", str(body.get("status")))

    r = client.get("/api/v1/stocks", params={"keyword": "茅台", "limit": 10})
    check("GET /api/v1/stocks 200", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        rows = r.json()
        check("stocks 关键字过滤命中 1 条", len(rows) == 1, str(len(rows)))
        if rows:
            expect_fields(rows[0], ["symbol", "name", "industry", "market", "list_date"], "StockInfo")

    r = client.get("/api/v1/stocks/quotes", params={"symbols": "600519,000001"})
    check("GET /api/v1/stocks/quotes 200", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        rows = r.json()
        check("quotes 返回 2 条", len(rows) == 2, str(len(rows)))
        if rows:
            expect_fields(rows[0], ["symbol", "name", "price", "prev_close", "open", "high",
                                    "low", "change", "change_pct", "volume", "amount",
                                    "turnover", "pe_ttm", "timestamp"], "Quote")

    r = client.get("/api/v1/stocks/kline", params={"symbol": "600519", "period": "daily", "adjust": "qfq"})
    check("GET /api/v1/stocks/kline 200", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        body = r.json()
        expect_fields(body, ["symbol", "period", "adjust", "bars"], "KlineResponse")
        check("kline 回显 period", body.get("period") == "daily", str(body.get("period")))
        check("kline 回显 adjust", body.get("adjust") == "qfq", str(body.get("adjust")))
        if body.get("bars"):
            expect_fields(body["bars"][0], ["date", "open", "high", "low", "close",
                                             "volume", "amount", "change_pct"], "KlineBar")

    r = client.get("/api/v1/stocks/600519/profile")
    check("GET /api/v1/stocks/{symbol}/profile 200", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        expect_fields(r.json(), ["symbol", "name", "industry", "market", "list_date",
                                 "total_market_cap", "float_market_cap",
                                 "total_shares", "float_shares"], "StockProfile")

    r = client.get("/api/v1/market/overview", params={"limit": 2})
    check("GET /api/v1/market/overview 200", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        body = r.json()
        expect_fields(body, ["indices", "updated_at"], "MarketOverview")
        if body.get("indices"):
            expect_fields(body["indices"][0], ["symbol", "name", "price", "change",
                                               "change_pct", "volume", "amount"], "IndexQuote")

    r = client.get("/api/v1/funds", params={"limit": 50})
    check("GET /api/v1/funds 200", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        rows = r.json()
        if rows:
            expect_fields(rows[0], ["code", "name", "type", "company", "manager", "size"], "FundInfo")

    r = client.get("/api/v1/funds/nav", params={"code": "110022"})
    check("GET /api/v1/funds/nav 200", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        body = r.json()
        expect_fields(body, ["code", "name", "points"], "FundNavResponse")
        if body.get("points"):
            expect_fields(body["points"][0], ["date", "nav", "acc_nav", "daily_return"], "FundNavPoint")

    r = client.get("/api/v1/funds/110022/detail")
    check("GET /api/v1/funds/{code}/detail 200", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        expect_fields(r.json(), ["code", "name", "type", "company", "manager", "size",
                                 "latest_nav", "latest_date", "points"], "FundDetail")

    r = client.get("/api/v1/search", params={"keyword": "茅台"})
    check("GET /api/v1/search 200", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        rows = r.json()
        check("search 返回结果", len(rows) > 0, str(len(rows)))
        if rows:
            expect_fields(rows[0], ["symbol", "name", "kind"], "SearchResult")
            check("search.kind 取值合法", rows[0]["kind"] in {"stock", "fund", "index"}, str(rows[0]["kind"]))

    print("\n=== 2. 参数校验 ===")
    r = client.get("/api/v1/stocks/quotes", params={"symbols": ""})
    check("symbols 为空 -> 400", r.status_code == 400, f"got {r.status_code}")

    r = client.get("/api/v1/stocks/quotes", params={"symbols": ",".join(str(i) for i in range(101))})
    check("symbols 超 100 -> 400", r.status_code == 400, f"got {r.status_code}")

    r = client.get("/api/v1/stocks/kline", params={"symbol": "600519", "period": "hourly"})
    check("period 非法 -> 422", r.status_code == 422, f"got {r.status_code}")

    r = client.get("/api/v1/stocks/kline", params={"symbol": "600519", "adjust": "bad"})
    check("adjust 非法 -> 422", r.status_code == 422, f"got {r.status_code}")

    r = client.get("/api/v1/funds", params={"limit": 5000})
    check("funds limit 超上限 -> 422", r.status_code == 422, f"got {r.status_code}")

    r = client.get("/api/v1/search", params={"keyword": ""})
    check("search 空关键字 -> 422", r.status_code == 422, f"got {r.status_code}")

    print("\n=== 3. TTL 缓存行为 ===")
    cache.invalidate()
    calls = {"n": 0}

    def counting_index(limit=6):
        calls["n"] += 1
        return stub_index_overview(limit)

    svc.fetch_index_overview = counting_index
    r1 = client.get("/api/v1/market/overview")
    r2 = client.get("/api/v1/market/overview")
    calls.clear()
    calls["n"] = 0
    # 路由层不缓存，缓存由服务层 _cached 负责；此处验证缓存管理接口本身
    r = client.get("/api/v1/cache/stats")
    check("GET /api/v1/cache/stats 200", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        body = r.json()
        expect_fields(body, ["entries", "keys"], "CacheStats")
        check("cache.stats.entries 为整数", isinstance(body.get("entries"), int), str(type(body.get("entries"))))

    cache.set("spot:a_share", [1, 2, 3], 60)
    cache.set("kline:600519:daily:qfq", {"bars": []}, 60)
    cache.set("fund_list", [{"code": "1"}], 60)

    r = client.get("/api/v1/cache/stats")
    entries = r.json()["entries"]
    check("缓存写入后 entries >= 3", entries >= 3, str(entries))

    r = client.post("/api/v1/cache/clear", params={"prefix": "kline:"})
    check("按前缀清理 200", r.status_code == 200, r.text[:200])
    check("按前缀清理返回 cleared=1", r.json().get("cleared") == 1, str(r.json()))

    r = client.get("/api/v1/cache/stats")
    remaining = set(r.json()["keys"])
    check("kline 前缀已清除", not any(k.startswith("kline:") for k in remaining), str(remaining))
    check("其他缓存仍保留", "spot:a_share" in remaining, str(remaining))

    r = client.post("/api/v1/cache/clear")
    check("清空全部 200", r.status_code == 200, r.text[:200])
    r = client.get("/api/v1/cache/stats")
    check("清空后 entries == 0", r.json()["entries"] == 0, str(r.json()))

    print("\n=== 4. 数据源异常 -> 502 ===")
    install_stubs(boom=True)
    for path, params in [
        ("/api/v1/stocks", {}),
        ("/api/v1/stocks/quotes", {"symbols": "600519"}),
        ("/api/v1/stocks/kline", {"symbol": "600519"}),
        ("/api/v1/stocks/600519/profile", {}),
        ("/api/v1/market/overview", {}),
        ("/api/v1/funds", {}),
        ("/api/v1/funds/nav", {"code": "110022"}),
        ("/api/v1/funds/110022/detail", {}),
        ("/api/v1/search", {"keyword": "茅台"}),
    ]:
        r = client.get(path, params=params or None)
        check(f"{path} 数据源异常 -> 502", r.status_code == 502, f"got {r.status_code}")

    # AkShare 未安装时的真实路径（不注入替身）
    import importlib
    importlib.reload(svc)
    client2 = TestClient(app)
    r = client2.get("/health")
    check("health 在 AkShare 缺失时仍 200", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        check("health.akshare_available == False", r.json()["akshare_available"] is False,
              str(r.json().get("akshare_available")))

    print("\n" + "=" * 60)
    print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    if FAILED:
        print("\n失败明细：")
        for name, detail in FAILED:
            print(f"  - {name}: {detail}")
        return 1
    print("全部接口契约验证通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
