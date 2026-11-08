# --- Stufe 1: libgourou (acsmdownloader, adept_activate, adept_remove) bauen ---
FROM debian:bookworm-slim AS builder
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
      build-essential git ca-certificates libzip-dev libssl-dev libcurl4-gnutls-dev libpugixml-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src
# libgourou-Quellen: vendorte Kopie aus chrisvariety/acsm-converter (v0.8.9,
# weil forge.soutade.fr oft nicht erreichbar ist). Deren lib/updfparser ist dort
# per .gitignore ausgeschlossen, daher wird uPDFParser separat geholt: zuerst
# vom Upstream, sonst von einem GitHub-Spiegel (Drittanbieter – per Build-Arg
# austauschbar).
ARG ACSM_CONVERTER_REPO=https://github.com/chrisvariety/acsm-converter.git
ARG ACSM_CONVERTER_REF=main
ARG UPDFPARSER_REPO=https://forge.soutade.fr/soutade/uPDFParser.git
ARG UPDFPARSER_MIRROR=https://github.com/rledisez/uPDFParser.git
RUN git clone --depth 1 --branch "$ACSM_CONVERTER_REF" "$ACSM_CONVERTER_REPO" ref \
    && cp -r ref/vendor/libgourou /usr/src/libgourou \
    && mkdir -p /usr/src/libgourou/lib \
    && (git clone --depth 1 "$UPDFPARSER_REPO" /usr/src/libgourou/lib/updfparser \
        || git clone --depth 1 "$UPDFPARSER_MIRROR" /usr/src/libgourou/lib/updfparser) \
    && cd /usr/src/libgourou/lib/updfparser && make BUILD_STATIC=1 BUILD_SHARED=0 \
    && cd /usr/src/libgourou && make BUILD_STATIC=1 STATIC_UTILS=1

# --- Stufe 2: App ---
FROM python:3.12-slim-bookworm
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
      libzip4 libssl3 libcurl3-gnutls libpugixml1v5 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/src/libgourou/utils/acsmdownloader \
                    /usr/src/libgourou/utils/adept_activate \
                    /usr/src/libgourou/utils/adept_remove /usr/local/bin/
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
