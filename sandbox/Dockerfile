# The run_code image. Build it once, then pin the id it prints as lab.toml [sandbox] image:
#   docker build -t aliquot-sandbox sandbox && docker image inspect --format '{{.Id}}' aliquot-sandbox
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      r-base-core r-recommended \
      python3 python3-numpy python3-pandas python3-scipy python3-statsmodels \
 && apt-get clean \
 && find /var/lib/apt/lists -mindepth 1 -delete

# The worker runs every container as 65534 with a read-only root; /work and /out are tmpfs mounts.
ENV HOME=/work MPLCONFIGDIR=/work PYTHONDONTWRITEBYTECODE=1
WORKDIR /work
USER 65534:65534
