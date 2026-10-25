# Build context: buninu-browser root. Single-stage, js-udocker-compatible syntax.
FROM oven/bun:1.4.4
ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/root
ENV LC_ALL=C.UTF-8
RUN set -eu; if [ -f /usr/bin/perl ] && [ ! -e /usr/bin/perl5.40.1 ]; then cp /usr/bin/perl /usr/bin/perl5.40.1; fi
RUN set -eu; apt-get update; apt-get install -y --no-install-recommends ca-certificates curl libgcc-s1; apt-get clean
RUN set -eu; mkdir -p /opt/omastorm; curl -fL --retry 3 https://codeload.github.com/wesleygrimes/omastorm/tar.gz/492e97841146bd9d6d9f7a3064e5e1ae9840cc68 -o /tmp/omastorm.tar.gz; tar -xzf /tmp/omastorm.tar.gz --strip-components=1 -C /opt/omastorm; rm /tmp/omastorm.tar.gz
RUN set -eu; cd /opt/omastorm; XDG_DATA_HOME=/usr/local/share bash scripts/fetch-engine.sh; ln -sfn /usr/local/share/omastorm/bin/omastorm-engine /usr/local/bin/omastorm-engine
RUN set -eu; mkdir -p /usr/local/share/fonts/omastorm; curl -fL --retry 3 https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/JetBrainsMono/Ligatures/Regular/JetBrainsMonoNerdFontMono-Regular.ttf -o /usr/local/share/fonts/omastorm/JetBrainsMonoNerdFontMono-Regular.ttf; curl -fL --retry 3 https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/JetBrainsMono/Ligatures/Regular/OFL.txt -o /usr/local/share/fonts/omastorm/OFL.txt
COPY index.js /opt/buninu-browser/index.js
COPY buninu-browser.js /opt/buninu-browser/buninu-browser.js
COPY frontends /opt/buninu-browser/frontends
COPY usr /opt/buninu-browser/usr
COPY lib /opt/buninu-browser/lib
COPY vendor /opt/buninu-browser/vendor
COPY LICENSES /opt/buninu-browser/LICENSES
COPY LICENSE /opt/buninu-browser/LICENSE
COPY THIRD_PARTY_NOTICES.md /opt/buninu-browser/THIRD_PARTY_NOTICES.md
COPY package.json /opt/buninu-browser/package.json
COPY test/fixtures/omastorm-helpers /usr/local/lib/omastorm-helpers
ENV OMASTORM_ROOT=/opt/omastorm
ENV OMASTORM_ENGINE_BINARY=/usr/local/bin/omastorm-engine
ENV QT_QPA_FONTDIR=/usr/local/share/fonts/omastorm
ENV XDG_RUNTIME_DIR=/tmp
ENV WAYLAND_DISPLAY=/tmp/wayland-buninu
ENV XDG_CONFIG_HOME=/root/.config
ENV XDG_DATA_HOME=/root/.local/share
ENV XDG_STATE_HOME=/root/.local/state
ENV XDG_CACHE_HOME=/root/.cache
RUN bun /usr/local/lib/omastorm-helpers/prepare.mjs /opt/omastorm
RUN bun /usr/local/lib/omastorm-helpers/check.mjs
WORKDIR /root
ENTRYPOINT []
CMD ["bun", "/usr/local/lib/omastorm-helpers/launch.mjs"]
