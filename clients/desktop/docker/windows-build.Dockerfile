# syntax=docker/dockerfile:1
#
# The Windows installer, cross-compiled on Linux with cargo-xwin, so the same source gives the same
# bytes on any machine with Docker (docs/reproducible-builds.md). Signing is not here: Authenticode
# runs on a Windows runner (sign-windows.yml) over what this builds, and the updater key never
# comes near a container.
#
# Debian 13 rather than the 12 the Linux packages need for their glibc floor: nothing from this
# image ships except what it compiles for Windows, and Tauri's installer script wants NSIS 3.11's
# Win\RestartManager.nsh, which 12 lacks. Build it as linux/arm64 on every host: the platform the
# build runs on shapes the output (see the WASM), and arm64 is native on Apple silicon and on CI's
# arm runners alike.

FROM debian:13@sha256:9c6e381421d0f48d1b8133e573f33c185ee16cbf505eda9c4a8a4791b25ea8a6

ENV DEBIAN_FRONTEND=noninteractive

# A dated snapshot, as in linux-build.Dockerfile.
ARG DEBIAN_SNAPSHOT=20261128T031751Z
RUN sed -i \
      -e "s|^URIs: http://deb.debian.org/debian-security\$|URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}|" \
      -e "s|^URIs: http://deb.debian.org/debian\$|URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}|" \
      /etc/apt/sources.list.d/debian.sources \
    && grep -q snapshot.debian.org/archive/debian/ /etc/apt/sources.list.d/debian.sources \
    && echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99snapshot

# clang-cl compiles the C in ring and friends, lld-link links, llvm-lib archives; makensis packs.
# 7zip unpacks a published installer, whose signed files a rebuild of that release puts back in.
# libayatana-appindicator3-dev and pkg-config only because the Tauri CLI looks the library up on any
# Linux host, whatever the target, and aborts without it. Nothing of it reaches the Windows build.
RUN apt-get update && apt-get install -y --no-install-recommends \
      7zip \
      ca-certificates \
      libayatana-appindicator3-dev \
      clang \
      curl \
      git \
      lld \
      llvm \
      nsis \
      pkg-config \
      rsync \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

# NSIS stores each packed file's modification time, and Tauri rewrites the binary just before packing
# it, so those times are the build's. SetDateSave off stops it storing them; installed files take the
# time they are installed. Tauri runs `makensis` from PATH with no way to pass an option, hence the
# wrapper ahead of it. makensis takes the installer's own time from SOURCE_DATE_EPOCH.
RUN printf '#!/bin/sh\nexec /usr/bin/makensis "-XSetDateSave off" "$@"\n' > /usr/local/bin/makensis \
    && chmod +x /usr/local/bin/makensis

ARG NODE_VERSION=24.21.0
ARG NODE_SHA256=6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2
RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
    && rm /tmp/node.tar.xz \
    && corepack enable

# rust-toolchain.toml pins the toolchain; rustup fetches it on first use, as in linux-build.
ENV RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo \
    PATH=/opt/cargo/bin:/usr/local/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --default-toolchain 1.95.0 --profile minimal \
    && rustup target add x86_64-pc-windows-msvc \
    && cargo install --locked cargo-xwin --version 0.23.1 \
    && rm -rf /opt/cargo/registry \
    && chmod -R a+rwX /opt/rustup /opt/cargo

# The Microsoft CRT and Windows SDK cargo-xwin downloads, by version: XWIN_ACCEPT_LICENSE is the
# Microsoft licence for those, which cargo-xwin otherwise accepts on our behalf without saying so.
ENV XWIN_ACCEPT_LICENSE=1 \
    XWIN_VERSION=17 \
    XWIN_CRT_VERSION=14.44.17.14 \
    XWIN_SDK_VERSION=10.0.26100

RUN mkdir -p /work /out /home/builder && chmod -R a+rwX /work /out /home/builder
ENV HOME=/home/builder
WORKDIR /work
