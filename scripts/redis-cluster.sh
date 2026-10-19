#!/bin/sh
# Starts or stops a Redis Cluster for `npm run test:cluster`: three masters, each with one
# replica, so the minReplications tests can see a write replicated.
#
# All six nodes run inside one container and announce 127.0.0.1, so the
# addresses they hand out in MOVED replies and CLUSTER SLOTS are the published
# ports on the host. That works the same on a CI runner and on Docker Desktop.
#
#   scripts/redis-cluster.sh up      start the cluster and wait for cluster_state:ok
#   scripts/redis-cluster.sh down    remove the container
#
# REDIS_CLUSTER_PORT (default 7100) is the first of six consecutive ports.
# Port 7000 is avoided on purpose: macOS uses it for the AirPlay receiver.
set -eu

NAME="${REDIS_CLUSTER_CONTAINER:-ioredfour-cluster}"
IMAGE="${REDIS_CLUSTER_IMAGE:-redis:7.4.11-alpine}"
P1="${REDIS_CLUSTER_PORT:-7100}"
P2=$((P1 + 1))
P3=$((P1 + 2))
P4=$((P1 + 3))
P5=$((P1 + 4))
P6=$((P1 + 5))

case "${1:-}" in
up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p "127.0.0.1:$P1-$P6:$P1-$P6" "$IMAGE" sh -c "
        for p in $P1 $P2 $P3 $P4 $P5 $P6; do
            redis-server --port \$p --cluster-enabled yes --cluster-config-file nodes-\$p.conf \
                --cluster-announce-ip 127.0.0.1 --appendonly no --save '' --daemonize yes \
                --logfile /data/redis-\$p.log --dir /data
        done
        for p in $P1 $P2 $P3 $P4 $P5 $P6; do
            until redis-cli -p \$p ping >/dev/null 2>&1; do sleep 0.1; done
        done
        redis-cli --cluster create 127.0.0.1:$P1 127.0.0.1:$P2 127.0.0.1:$P3 127.0.0.1:$P4 127.0.0.1:$P5 127.0.0.1:$P6 \
            --cluster-replicas 1 --cluster-yes
        tail -f /data/redis-$P1.log
    " >/dev/null

    i=0
    until docker exec "$NAME" redis-cli -p "$P1" cluster info 2>/dev/null | grep -q 'cluster_state:ok'; do
        i=$((i + 1))
        if [ "$i" -gt 60 ]; then
            echo "Redis Cluster did not reach cluster_state:ok" >&2
            docker logs "$NAME" >&2 || true
            exit 1
        fi
        sleep 1
    done
    # The replicas finish their first sync after the cluster reports ok
    for p in $P1 $P2 $P3 $P4 $P5 $P6; do
        until docker exec "$NAME" redis-cli -p "$p" info replication | grep -qE 'connected_slaves:1|master_link_status:up'; do
            i=$((i + 1))
            if [ "$i" -gt 120 ]; then
                echo "Redis Cluster replicas did not come up" >&2
                docker logs "$NAME" >&2 || true
                exit 1
            fi
            sleep 1
        done
    done
    echo "Redis Cluster ready on 127.0.0.1:$P1-$P6"
    ;;
down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    ;;
*)
    echo "Usage: $0 up|down" >&2
    exit 2
    ;;
esac
