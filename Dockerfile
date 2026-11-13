# 机器人镜像。NapCat 那个在 ~/linmuAIBot/Dockerfile，两个都由 scripts/build_images.sh 构建。
#
# 版本全锁死：底座按 digest，Python 依赖按 uv.lock（带 hash 导出，pip 装的时候逐个校验）。
# 不装 uv 进镜像：它只在构建期做一次导出，运行时就是普通的 python -m bot。
FROM python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai

# 依赖单独一层：只改代码时这层直接用缓存，不用重装
COPY requirements.lock /tmp/requirements.lock
# 走阿里云 PyPI 镜像，国内不用开 VPN。--require-hashes 保证下来的包跟 uv.lock 里一字不差，
# 镜像站要是给了别的东西，hash 对不上直接失败
RUN pip install --no-cache-dir --require-hashes \
        -i https://mirrors.aliyun.com/pypi/simple/ -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock

WORKDIR /app
COPY bot/ bot/
COPY scripts/ scripts/
COPY pyproject.toml ./

# data/ knowledge/ logs/ .env 都由 compose 挂进来（见 docker-compose.yml），这里不放
CMD ["python", "-m", "bot"]
