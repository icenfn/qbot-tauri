"""应用配置。

通过环境变量或 backend/.env 覆盖，便于同一份代码在开发机、家庭服务器、
Docker 中复用。Android 端只需要把地址指向可访问的服务器即可。
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="QBOT_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Qbot Data Service"
    version: str = "0.1.0"

    # 监听地址：0.0.0.0 便于 Android 真机通过局域网访问
    host: str = "0.0.0.0"
    port: int = 8000

    # 允许的来源。移动端与桌面端 WebView 的 Origin 各不相同，默认放开。
    # 生产环境请收敛为具体域名。
    cors_origins: list[str] = ["*"]

    # AkShare 请求失败重试次数
    akshare_retries: int = 2
    # 单次请求超时（秒）
    request_timeout: float = 20.0


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
