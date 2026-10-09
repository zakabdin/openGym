FROM alpine:3
RUN apk add --no-cache git ffmpeg findutils
COPY upscale-media.sh /usr/local/bin/upscale-media
RUN chmod +x /usr/local/bin/upscale-media
