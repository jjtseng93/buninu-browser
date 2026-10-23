# Build context: buninu-browser repository root. Compatible with js-udocker.
FROM oven/bun:1.4.4
ENV DEBIAN_FRONTEND=noninteractive
ENV LC_ALL=C.UTF-8
RUN set -eu; if [ -f /usr/bin/perl ] && [ ! -e /usr/bin/perl5.40.1 ]; then cp /usr/bin/perl /usr/bin/perl5.40.1; fi
RUN set -eu; apt-get update; apt-get install -y --no-install-recommends ca-certificates curl zstd shared-mime-info util-linux libgcc-s1; apt-get clean
RUN set -eu; case "$(uname -m)" in aarch64|arm64) arch=aarch64 ;; x86_64) arch=x86_64 ;; *) exit 1 ;; esac; curl -fL --retry 3 "https://pkgs.omarchy.org/stable/$arch/flea-0.3.12-1-$arch.pkg.tar.zst" -o /tmp/flea.pkg.tar.zst; tar --zstd -xf /tmp/flea.pkg.tar.zst -C / usr; /usr/bin/flea --version
RUN set -eu; mkdir -p /tmp/omarchy-source /usr/share/omarchy/shell; curl -fL --retry 3 https://codeload.github.com/basecamp/omarchy/tar.gz/3c7027db2a4fa9fa6a49d7af7f87c27ac48e677d -o /tmp/omarchy.tar.gz; tar -xzf /tmp/omarchy.tar.gz --strip-components=1 -C /tmp/omarchy-source omarchy-3c7027db2a4fa9fa6a49d7af7f87c27ac48e677d/shell/Commons omarchy-3c7027db2a4fa9fa6a49d7af7f87c27ac48e677d/shell/Ui omarchy-3c7027db2a4fa9fa6a49d7af7f87c27ac48e677d/LICENSE; cp -a /tmp/omarchy-source/shell/Commons /tmp/omarchy-source/shell/Ui /usr/share/omarchy/shell/; ln -sfn shell /usr/share/omarchy/qs; cp /tmp/omarchy-source/LICENSE /usr/share/omarchy/LICENSE
COPY buninu-browser.js /opt/buninu-browser/buninu-browser.js
COPY frontends /opt/buninu-browser/frontends
COPY usr /opt/buninu-browser/usr
COPY lib /opt/buninu-browser/lib
COPY vendor /opt/buninu-browser/vendor
COPY LICENSES /opt/buninu-browser/LICENSES
COPY LICENSE /opt/buninu-browser/LICENSE
COPY THIRD_PARTY_NOTICES.md /opt/buninu-browser/THIRD_PARTY_NOTICES.md
COPY package.json /opt/buninu-browser/package.json
COPY test/fixtures/flea-helpers /usr/local/lib/flea-helpers
COPY test/fixtures/flea-thumbnail-stub /opt/flea-thumbnail-stub
COPY test/fixtures/tone.mp3 /root/flea-demo/tone.mp3
COPY test/fixtures/long-video.mp4 /root/flea-demo/long-video.mp4
WORKDIR /usr/local/lib/flea-helpers
RUN set -eu; bun i --backend=copyfile jsmdcui@0.19.2; chmod +x /usr/local/lib/flea-helpers/bin/*; for tool in qs bat glow bwrap; do ln -sfn /usr/local/lib/flea-helpers/bin/$tool /usr/local/bin/$tool; done; install -Dm755 /opt/flea-thumbnail-stub/flea-thumbnail-stub /usr/local/bin/flea-thumbnail-stub; install -Dm644 /opt/flea-thumbnail-stub/flea-placeholder.thumbnailer /usr/share/thumbnailers/flea-placeholder.thumbnailer
RUN set -eu; install -Dm644 source-mime.xml /usr/share/mime/packages/buninu-source.xml; update-mime-database /usr/share/mime
RUN set -eu; printf 'const answer = 42;\n' > /root/flea-demo/hello.js; bun /usr/local/lib/flea-helpers/check.mjs
ENV HOME=/root
ENV XDG_RUNTIME_DIR=/tmp
ENV WAYLAND_DISPLAY=wayland-buninu
ENV XDG_CONFIG_HOME=/root/.config
ENV XDG_DATA_HOME=/root/.local/share
ENV XDG_STATE_HOME=/root/.local/state
ENV XDG_CACHE_HOME=/root/.cache
ENV QSG_RHI_BACKEND=opengl
WORKDIR /root
ENTRYPOINT []
CMD ["/usr/bin/flea", "--gui", "/root/flea-demo"]
