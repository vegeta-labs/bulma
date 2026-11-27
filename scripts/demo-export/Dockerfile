# The export's throwaway database only (plan 05 §5.6): Postgres with libfaketime preloaded for the server process alone, so
# now() and clock_timestamp() read the export's clock. Never used by the app, its tests or a deployment. libfaketime (GPL-2)
# stays in this image; it is not shipped in the pack or in any npm dependency.
FROM postgres:16
RUN apt-get update \
 && apt-get install -y --no-install-recommends faketime \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s "$(ls /usr/lib/*/faketime/libfaketime.so.1)" /usr/local/lib/libfaketime.so.1 \
 && grep -c '^[[:space:]]*exec "\$@"' /usr/local/bin/docker-entrypoint.sh \
 && sed -i 's|^\([[:space:]]*\)exec "\$@"|\1LD_PRELOAD=/usr/local/lib/libfaketime.so.1 exec "$@"|' /usr/local/bin/docker-entrypoint.sh \
 && grep -q 'LD_PRELOAD=/usr/local/lib/libfaketime.so.1 exec' /usr/local/bin/docker-entrypoint.sh \
 && mkdir /faketime && echo '+0' > /faketime/offset && chown postgres /faketime/offset
# preloading the whole entrypoint hangs initdb, so only the final server process gets the library (set above)
ENV FAKETIME_TIMESTAMP_FILE=/faketime/offset FAKETIME_NO_CACHE=1 TZ=UTC
