# Builds the Piper phonemizer (piper-phonemize + eSpeak NG) to WebAssembly from pinned sources.
# The outputs are GPL-3.0-or-later because they contain eSpeak NG; see ../licenses/espeak-ng-SOURCE.txt.
# Usage: phonemizer/build.sh   (wraps: docker build --output type=local,dest=<dir> phonemizer)
#
# These are the steps of https://github.com/diffusion-studio/piper-wasm (the npm package this replaces),
# with every source pinned to a commit and eSpeak NG's data built from the same commit as its code.

# Debian 12 (multi-arch: the build runs natively on x86-64 and arm64 hosts).
FROM debian:12-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS build

# Rhasspy's eSpeak NG fork, at the commit piper-phonemize's CMakeLists.txt downloads.
ARG ESPEAK_NG_COMMIT=0f65aa301e0d6bae5e172cc74197d32a6182200f
# piper-phonemize with the wasm changes (fork of rhasspy/piper-phonemize).
ARG PIPER_PHONEMIZE_COMMIT=cfff8e52ebaea37c7e953ae2d06b174acb827ac4

RUN apt-get update \
 && apt-get install --yes --no-install-recommends build-essential cmake ca-certificates curl git python3 xz-utils \
      autoconf automake libtool pkg-config \
 && rm -rf /var/lib/apt/lists/*

# Fetch a GitHub repository at an exact commit.
RUN printf '#!/bin/sh\nset -e\nmkdir -p "$3" && cd "$3" && git init -q && git remote add origin "https://github.com/$1.git" \\\n  && git fetch -q --depth 1 origin "$2" && git checkout -q FETCH_HEAD\n' > /usr/local/bin/fetch-commit \
 && chmod +x /usr/local/bin/fetch-commit

# Emscripten 3.1.47, as used by the original build, installed by emsdk at its matching tag.
ARG EMSDK_COMMIT=37b85e9eaee5be090569d018cca77a15cacc11b7
RUN fetch-commit emscripten-core/emsdk "$EMSDK_COMMIT" /emsdk \
 && /emsdk/emsdk install 3.1.47 && /emsdk/emsdk activate 3.1.47
ENV EMSDK=/emsdk PATH=/emsdk:/emsdk/upstream/emscripten:$PATH
# Generate the sysroot (emscripten creates it lazily) so its wchar.h can be patched.
RUN printf 'int main(void){return 0;}\n' > /tmp/t.c && emcc /tmp/t.c -o /tmp/t.js && rm /tmp/t.*

# emscripten's wchar.h declares isw* functions that clash with eSpeak NG's own (same patch as upstream).
RUN sed -i -E 's/int\s+(iswalnum|iswalpha|iswblank|iswcntrl|iswgraph|iswlower|iswprint|iswpunct|iswspace|iswupper|iswxdigit)\(wint_t\)/\/\/\0/g' \
      "$EMSDK/upstream/emscripten/cache/sysroot/include/wchar.h"

# 1. Native eSpeak NG build. Only its compiled espeak-ng-data (phoneme tables, dictionaries) is used:
#    the data compiler can't run as wasm during the cross build.
RUN fetch-commit rhasspy/espeak-ng "$ESPEAK_NG_COMMIT" /src/espeak-ng
WORKDIR /src/espeak-ng
RUN ./autogen.sh && ./configure && make -j"$(nproc)"

# 2. piper-phonemize + eSpeak NG compiled to wasm, with the data from step 1 preloaded as /espeak-ng-data.
RUN fetch-commit wide-video/piper-phonemize "$PIPER_PHONEMIZE_COMMIT" /src/piper-phonemize
WORKDIR /src/piper-phonemize
# piper-phonemize downloads eSpeak NG itself; point it at the same commit (it already is, this enforces it).
RUN grep -q "espeak-ng/archive/${ESPEAK_NG_COMMIT}.zip" CMakeLists.txt
RUN emcmake cmake -Bbuild -DCMAKE_INSTALL_PREFIX=install -DBUILD_TESTING=OFF -G "Unix Makefiles" \
      -DCMAKE_CXX_FLAGS="-O3 -s INVOKE_RUN=0 -s MODULARIZE=1 -s EXPORT_NAME='createPiperPhonemize' -s EXPORTED_FUNCTIONS='[_main]' -s EXPORTED_RUNTIME_METHODS='[callMain, FS]' --preload-file /src/espeak-ng/espeak-ng-data@/espeak-ng-data"
# The first build stops at eSpeak NG's data step (it would run the wasm binary natively); skip that step
# and fix a speechPlayer compile error, then build again. Same workaround as upstream.
RUN emmake cmake --build build --config Release -j"$(nproc)" || true
RUN sed -i 's+$(MAKE) $(MAKESILENT) -f CMakeFiles/data.dir/build.make CMakeFiles/data.dir/build+#\0+g' \
      build/e/src/espeak_ng_external-build/CMakeFiles/Makefile2 \
 && sed -i 's/using namespace std/\/\/\0/g' \
      build/e/src/espeak_ng_external/src/speechPlayer/src/speechWaveGenerator.cpp
RUN emmake cmake --build build --config Release -j"$(nproc)"
RUN mkdir /out && cp build/piper_phonemize.js build/piper_phonemize.wasm build/piper_phonemize.data /out/ \
 && printf 'emscripten 3.1.47 (emsdk %s)\nrhasspy/espeak-ng %s\nwide-video/piper-phonemize %s\n' "$EMSDK_COMMIT" "$ESPEAK_NG_COMMIT" "$PIPER_PHONEMIZE_COMMIT" > /out/VERSIONS

FROM scratch
COPY --from=build /out/ /
