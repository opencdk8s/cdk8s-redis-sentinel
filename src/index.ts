import { Construct } from 'constructs';
import * as k8s from './imports/k8s';

export * from './imports/k8s';

export interface RedisOptions {
  /**
    * The number of replicas for the sts.
    * @default 3
  */
  readonly replicas?: number;
  /**
   * The redis image to use
   * @default docker.io/bitnami/redis-sentinel:6.2.6-debian-10-r49'
   */
  readonly redisImage?: string;
  /**
   * The size of volume to use
   */
  readonly volumeSize: string;
  /**
    * The volumeType - gp2/gp3/io1/io2 etc
    * @default gp2
    */
  readonly volumeType?: string;
  /**
    * The volumeIops per GB
    * @default 3
    */
  readonly volumeIopsPerGb?: string;
  /**
    * The volume FS Type - ext4/ext3/xfs etc
    * @default ext4
    */
  readonly volumeFsType?: string;
  /**
   * The redis password
   */
  readonly redisPassword: string;
  /**
   * Node Selectors
   * @default undefined
   */
  readonly nodeSelector?: { [key: string]: string };
  /**
   * Tolerations
   * @default undefined
   */
  readonly tolerations?: k8s.Toleration[];
}

export class Redis extends Construct {
  constructor(scope: Construct, name: string, opts: RedisOptions) {
    super(scope, name);

    const storageClass = new k8s.KubeStorageClass(this, 'storageClass', {
      provisioner: 'kubernetes.io/aws-ebs',
      parameters: {
        type: opts?.volumeType ?? 'gp2',
        iopsPerGB: opts?.volumeIopsPerGb ?? '3',
        fsType: opts.volumeFsType ?? 'ext4',
      },
    });


    const sa = new k8s.KubeServiceAccount(this, 'redis-sa', {
      automountServiceAccountToken: true,
      metadata: {
        name: name,
        labels: {
          name: name,
          instance: name,

        },
      },
    });

    const secret = new k8s.KubeSecret(this, 'redis-secret', {
      metadata: {
        name: name,
        labels: {
          name: name,
          instance: name,

        },
      },
      type: 'Opaque',
      data: {
        'redis-password': opts.redisPassword,
      },
    });

    const configCm = new k8s.KubeConfigMap(this, 'redis-configuration', {
      metadata: {
        name: `${name}-configuration`,
        labels: {
          name: name,

          instance: name,

        },
      },
      data: {
        'redis.conf': `-
    # User-supplied common configuration:
    # Enable AOF https://redis.io/topics/persistence#append-only-file
    appendonly yes
    # Disable RDB persistence, AOF persistence already enabled.
    save ""
    # End of common configuration
`,
        'master.conf': `-
    dir /data
    # User-supplied master configuration:
    rename-command FLUSHDB ""
    rename-command FLUSHALL ""
    # End of master configuration
`,
        'replica.conf': `-
    dir /data
    slave-read-only yes
    # User-supplied replica configuration:
    rename-command FLUSHDB ""
    rename-command FLUSHALL ""
    # End of replica configuration
`,
        'sentinel.conf': `-
    dir "/tmp"
    port 26379
    sentinel monitor mymaster redis-node-0.redis-headless.default.svc.cluster.local 6379 2
    sentinel down-after-milliseconds mymaster 60000
    sentinel failover-timeout mymaster 18000
    sentinel parallel-syncs mymaster 1
    # User-supplied sentinel configuration:
    # End of sentinel configuration
`,
      },
    });

    const healthCm = new k8s.KubeConfigMap(this, 'redis-health', {
      metadata: {
        name: `${name}-health`,
        labels: {
          name: name,
          instance: name,
        },
      },
      data: {
        'ping_readiness_local.sh': `#!/bin/bash
[[ -f $REDIS_PASSWORD_FILE ]] && export REDIS_PASSWORD="$(< "\${REDIS_PASSWORD_FILE}")"
[[ -n "$REDIS_PASSWORD" ]] && export REDISCLI_AUTH="$REDIS_PASSWORD"
response=$(
  timeout -s 3 $1 \
  redis-cli \
    -h localhost \
    -p $REDIS_PORT \
    ping
)
if [ "$response" != "PONG" ]; then
  echo "$response"
  exit 1
fi`,
        'ping_livesness_local.sh': `#!/bin/bash

[[ -f $REDIS_PASSWORD_FILE ]] && export REDIS_PASSWORD="$(< "\${REDIS_PASSWORD_FILE}")"
[[ -n "$REDIS_PASSWORD" ]] && export REDISCLI_AUTH="$REDIS_PASSWORD"
response=$(
  timeout -s 3 $1 \
  redis-cli \
    -h localhost \
    -p $REDIS_PORT \
    ping
)
if [ "$response" != "PONG" ] && [ "$response" != "LOADING Redis is loading the dataset in memory" ]; then
  echo "$response"
  exit 1
fi`,
        'ping_sentinel.sh': `#!/bin/bash
[[ -f $REDIS_PASSWORD_FILE ]] && export REDIS_PASSWORD="$(< "\${REDIS_PASSWORD_FILE}")"
[[ -n "$REDIS_PASSWORD" ]] && export REDISCLI_AUTH="$REDIS_PASSWORD"
response=$(
  timeout -s 3 $1 \
  redis-cli \
    -h localhost \
    -p $REDIS_SENTINEL_PORT \
    ping
)
if [ "$response" != "PONG" ]; then
  echo "$response"
  exit 1
fi`,
        'parse_sentinels.awk': `/ip/ {FOUND_IP=1}
/port/ {FOUND_PORT=1}
/runid/ {FOUND_RUNID=1}
!/ip|port|runid/ {
  if (FOUND_IP==1) {
    IP=$1; FOUND_IP=0;
  }
  else if (FOUND_PORT==1) {
    PORT=$1;
    FOUND_PORT=0;
  } else if (FOUND_RUNID==1) {
    printf "\nsentinel known-sentinel mymaster %s %s %s", IP, PORT, $0; FOUND_RUNID=0;
  }
}`,
        'ping_readiness_master.sh': `#!/bin/bash

[[ -f $REDIS_MASTER_PASSWORD_FILE ]] && export REDIS_MASTER_PASSWORD="$(< "\${REDIS_MASTER_PASSWORD_FILE}")"
[[ -n "$REDIS_MASTER_PASSWORD" ]] && export REDISCLI_AUTH="$REDIS_MASTER_PASSWORD"
response=$(
  timeout -s 3 $1 \
  redis-cli \
    -h $REDIS_MASTER_HOST \
    -p $REDIS_MASTER_PORT_NUMBER \
    ping
)
if [ "$response" != "PONG" ]; then
  echo "$response"
  exit 1
fi`,
        'ping_liveness_master.sh': `    #!/bin/bash

    [[ -f $REDIS_MASTER_PASSWORD_FILE ]] && export REDIS_MASTER_PASSWORD="$(< "\${REDIS_MASTER_PASSWORD_FILE}")"
    [[ -n "$REDIS_MASTER_PASSWORD" ]] && export REDISCLI_AUTH="$REDIS_MASTER_PASSWORD"
    response=$(
      timeout -s 3 $1 \
      redis-cli \
        -h $REDIS_MASTER_HOST \
        -p $REDIS_MASTER_PORT_NUMBER \
        ping
    )
    if [ "$response" != "PONG" ] && [ "$response" != "LOADING Redis is loading the dataset in memory" ]; then
      echo "$response"
      exit 1
    fi`,
        'ping_readiness_local_and_master.sh': `script_dir="$(dirname "$0")"
exit_status=0
"$script_dir/ping_readiness_local.sh" $1 || exit_status=$?
"$script_dir/ping_readiness_master.sh" $1 || exit_status=$?
exit $exit_status`,
        'ping_liveliness_local_and_master.sh': `script_dir="$(dirname "$0")"
exit_status=0
"$script_dir/ping_liveness_local.sh" $1 || exit_status=$?
"$script_dir/ping_liveness_master.sh" $1 || exit_status=$?
exit $exit_status`,

      },
    });

    const scriptsCm = new k8s.KubeConfigMap(this, 'redis-scripts', {
      metadata: {
        name: `${name}-scripts`,
        labels: {
          name: name,
          instance: name,
        },
      },
      data: {
        'start-node.sh': `#!/bin/bash

. /opt/bitnami/scripts/libos.sh
. /opt/bitnami/scripts/liblog.sh
. /opt/bitnami/scripts/libvalidations.sh

get_port() {
    hostname="$1"
    type="$2"

    port_var=$(echo "\${hostname^^}_SERVICE_PORT_$type" | sed "s/-/_/g")
    port=\${!port_var}
    
    if [ -z "$port" ]; then
        case $type in
            "SENTINEL")
                echo 26379
                ;;
            "REDIS")
                echo 6379
                ;;
        esac
    else
        echo $port
    fi
}

get_full_hostname() {
    hostname="$1"
    echo "\${hostname}.\${HEADLESS_SERVICE}"
}

REDISPORT=$(get_port "$HOSTNAME" "REDIS")

myip=$(hostname -i)

# If there are more than one IP, use the first IPv4 address
if [[ "$myip" = *" "* ]]; then
    myip=$(echo $myip | awk '{if ( match($0,/([0-9]+\.)([0-9]+\.)([0-9]+\.)[0-9]+/) ) { print substr($0,RSTART,RLENGTH); } }')
fi

HEADLESS_SERVICE="redis-headless.default.svc.cluster.local"
REDIS_SERVICE="redis.default.svc.cluster.local"
SENTINEL_SERVICE_PORT=$(get_port "redis" "TCP_SENTINEL")

not_exists_dns_entry() {
    if [[ -z "$(getent ahosts "$HEADLESS_SERVICE" | grep "^\${myip}" )" ]]; then
        warn "$HEADLESS_SERVICE does not contain the IP of this pod: \${myip}"
        return 1
    fi
    debug "$HEADLESS_SERVICE has my IP: \${myip}"
    return 0
}

validate_quorum() {
    if is_boolean_yes "$REDIS_TLS_ENABLED"; then
        quorum_info_command="REDISCLI_AUTH="\$REDIS_PASSWORD" redis-cli -h $REDIS_SERVICE -p $SENTINEL_SERVICE_PORT --tls --cert \${REDIS_TLS_CERT_FILE} --key \${REDIS_TLS_KEY_FILE} --cacert \${REDIS_TLS_CA_FILE} sentinel master mymaster"
    else
        quorum_info_command="REDISCLI_AUTH="\$REDIS_PASSWORD" redis-cli -h $REDIS_SERVICE -p $SENTINEL_SERVICE_PORT sentinel master mymaster"
    fi

    info "about to run the command: $quorum_info_command"
    eval $quorum_info_command | grep -Fq "s_down"
}

trigger_manual_failover() {
    if is_boolean_yes "$REDIS_TLS_ENABLED"; then
        failover_command="REDISCLI_AUTH="\$REDIS_PASSWORD" redis-cli -h $REDIS_SERVICE -p $SENTINEL_SERVICE_PORT --tls --cert \${REDIS_TLS_CERT_FILE} --key \${REDIS_TLS_KEY_FILE} --cacert \${REDIS_TLS_CA_FILE} sentinel failover mymaster"
    else
        failover_command="REDISCLI_AUTH="\$REDIS_PASSWORD" redis-cli -h $REDIS_SERVICE -p $SENTINEL_SERVICE_PORT sentinel failover mymaster"
    fi

    info "about to run the command: $failover_command"
    eval $failover_command
}

get_sentinel_master_info() {
    if is_boolean_yes "$REDIS_TLS_ENABLED"; then
        sentinel_info_command="REDISCLI_AUTH="\$REDIS_PASSWORD" redis-cli -h $REDIS_SERVICE -p $SENTINEL_SERVICE_PORT --tls --cert \${REDIS_TLS_CERT_FILE} --key \${REDIS_TLS_KEY_FILE} --cacert \${REDIS_TLS_CA_FILE} sentinel get-master-addr-by-name mymaster"
    else
        sentinel_info_command="REDISCLI_AUTH="\$REDIS_PASSWORD" redis-cli -h $REDIS_SERVICE -p $SENTINEL_SERVICE_PORT sentinel get-master-addr-by-name mymaster"
    fi

    info "about to run the command: $sentinel_info_command"
    eval $sentinel_info_command
}

[[ -f $REDIS_PASSWORD_FILE ]] && export REDIS_PASSWORD="$(< "\${REDIS_PASSWORD_FILE}")"
[[ -f $REDIS_MASTER_PASSWORD_FILE ]] && export REDIS_MASTER_PASSWORD="$(< "\${REDIS_MASTER_PASSWORD_FILE}")"

# Waits for DNS to add this ip to the service DNS entry
retry_while not_exists_dns_entry

if [[ -z "$(getent ahosts "$HEADLESS_SERVICE" | grep -v "^\${myip}")" ]]; then
    # Only node available on the network, master by default
    export REDIS_REPLICATION_MODE="master"
else
    export REDIS_REPLICATION_MODE="slave"
    
    # Fetches current master's host and port
    REDIS_SENTINEL_INFO=($(get_sentinel_master_info))
    info "printing REDIS_SENTINEL_INFO=(\${REDIS_SENTINEL_INFO[0]},\${REDIS_SENTINEL_INFO[1]})"
    REDIS_MASTER_HOST=\${REDIS_SENTINEL_INFO[0]}
    REDIS_MASTER_PORT_NUMBER=\${REDIS_SENTINEL_INFO[1]}
fi

if [[ "$REDIS_REPLICATION_MODE" = "master" ]]; then
    debug "Starting as master node"
    if [[ ! -f /opt/bitnami/redis/etc/master.conf ]]; then
        cp /opt/bitnami/redis/mounted-etc/master.conf /opt/bitnami/redis/etc/master.conf
    fi
else
    debug "Starting as replica node"
    if [[ ! -f /opt/bitnami/redis/etc/replica.conf ]];then
        cp /opt/bitnami/redis/mounted-etc/replica.conf /opt/bitnami/redis/etc/replica.conf
    fi
fi

if [[ ! -f /opt/bitnami/redis/etc/redis.conf ]];then
    cp /opt/bitnami/redis/mounted-etc/redis.conf /opt/bitnami/redis/etc/redis.conf
fi

echo "" >> /opt/bitnami/redis/etc/replica.conf
echo "replica-announce-port $REDISPORT" >> /opt/bitnami/redis/etc/replica.conf
echo "replica-announce-ip $(get_full_hostname "$HOSTNAME")" >> /opt/bitnami/redis/etc/replica.conf
ARGS=("--port" "\${REDIS_PORT}")

if [[ "$REDIS_REPLICATION_MODE" = "slave" ]]; then
    ARGS+=("--slaveof" "\${REDIS_MASTER_HOST}" "\${REDIS_MASTER_PORT_NUMBER}")
fi
ARGS+=("--requirepass" "\${REDIS_PASSWORD}")
ARGS+=("--masterauth" "\${REDIS_MASTER_PASSWORD}")
if [[ "$REDIS_REPLICATION_MODE" = "master" ]]; then
    ARGS+=("--include" "/opt/bitnami/redis/etc/master.conf")
else
    ARGS+=("--include" "/opt/bitnami/redis/etc/replica.conf")
fi
ARGS+=("--include" "/opt/bitnami/redis/etc/redis.conf")
exec redis-server "\${ARGS[@]}"`,
        'start-sentinel.sh': `#!/bin/bash

. /opt/bitnami/scripts/libos.sh
. /opt/bitnami/scripts/libvalidations.sh
. /opt/bitnami/scripts/libfile.sh

HEADLESS_SERVICE="redis-headless.default.svc.cluster.local"
REDIS_SERVICE="redis.default.svc.cluster.local"

get_port() {
    hostname="$1"
    type="$2"

    port_var=$(echo "\${hostname^^}_SERVICE_PORT_$type" | sed "s/-/_/g")
    port=\${!port_var}
    
    if [ -z "$port" ]; then
        case $type in
            "SENTINEL")
                echo 26379
                ;;
            "REDIS")
                echo 6379
                ;;
        esac
    else
        echo $port
    fi
}
    
get_full_hostname() {
    hostname="$1"
    echo "\${hostname}.\${HEADLESS_SERVICE}"
}

SERVPORT=$(get_port "$HOSTNAME" "SENTINEL")
REDISPORT=$(get_port "$HOSTNAME" "REDIS")
SENTINEL_SERVICE_PORT=$(get_port "redis" "TCP_SENTINEL")
    
myip=$(hostname -i)

# If there are more than one IP, use the first IPv4 address
if [[ "$myip" = *" "* ]]; then
    myip=$(echo $myip | awk '{if ( match($0,/([0-9]+\\.)([0-9]+\\.)([0-9]+\\.)[0-9]+/) ) { print substr($0,RSTART,RLENGTH); } }')
fi


sentinel_conf_set() {
    local -r key="\${1:?missing key}"
    local value="\${2:-}"

    # Sanitize inputs
    value="\${value//\\\\/\\\\\\\\}"
    value="\${value//&/\\&}"
    value="\${value//\?/\\?}"
    [[ "$value" = "" ]] && value="\\"$value\\""

    replace_in_file "/opt/bitnami/redis-sentinel/etc/sentinel.conf" "^#*\\s*\\\${key} .*" "\${key} \${value}" false
}
sentinel_conf_add() {
    echo $'\\n'"$@" >> "/opt/bitnami/redis-sentinel/etc/sentinel.conf"
}
host_id() {
    echo "$1" | openssl sha1 | awk '{print $2}'
}
not_exists_dns_entry() {
    if [[ -z "$(getent ahosts "$HEADLESS_SERVICE" | grep "^\${myip}" )" ]]; then
        warn "$HEADLESS_SERVICE does not contain the IP of this pod: \${myip}"
        return 1
    fi
    debug "$HEADLESS_SERVICE has my IP: \${myip}"
    return 0
}
get_sentinel_master_info() {
    if is_boolean_yes "$REDIS_TLS_ENABLED"; then
        sentinel_info_command="REDISCLI_AUTH="\$REDIS_PASSWORD" redis-cli -h $REDIS_SERVICE -p $SENTINEL_SERVICE_PORT --tls --cert \${REDIS_TLS_CERT_FILE} --key \${REDIS_TLS_KEY_FILE} --cacert \${REDIS_TLS_CA_FILE} sentinel get-master-addr-by-name mymaster"
    else
        sentinel_info_command="REDISCLI_AUTH="\$REDIS_PASSWORD" redis-cli -h $REDIS_SERVICE -p $SENTINEL_SERVICE_PORT sentinel get-master-addr-by-name mymaster"
    fi

    info "about to run the command: $sentinel_info_command"
    eval $sentinel_info_command
}

# Waits for DNS to add this ip to the service DNS entry
retry_while not_exists_dns_entry

[[ -f $REDIS_PASSWORD_FILE ]] && export REDIS_PASSWORD="$(< "\${REDIS_PASSWORD_FILE}")"

cp /opt/bitnami/redis-sentinel/mounted-etc/sentinel.conf /opt/bitnami/redis-sentinel/etc/sentinel.conf
printf "\\nsentinel auth-pass %s %s" "mymaster" "$REDIS_PASSWORD" >> /opt/bitnami/redis-sentinel/etc/sentinel.conf
printf "\\nrequirepass %s" "$REDIS_PASSWORD" >> /opt/bitnami/redis-sentinel/etc/sentinel.conf
printf "\\nsentinel myid %s" "$(host_id "$HOSTNAME")" >> /opt/bitnami/redis-sentinel/etc/sentinel.conf

if [[ -z "$(getent ahosts "$HEADLESS_SERVICE" | grep -v "^\${myip}")" ]]; then
    # Only node available on the network, master by default
    export REDIS_REPLICATION_MODE="master"

    REDIS_MASTER_HOST=$(get_full_hostname "$HOSTNAME")
    REDIS_MASTER_PORT_NUMBER="$REDISPORT"
else
    export REDIS_REPLICATION_MODE="slave"

    # Fetches current master's host and port
    REDIS_SENTINEL_INFO=($(get_sentinel_master_info))
    info "printing REDIS_SENTINEL_INFO=(\${REDIS_SENTINEL_INFO[0]},\${REDIS_SENTINEL_INFO[1]})" 
    REDIS_MASTER_HOST=\${REDIS_SENTINEL_INFO[0]}
    REDIS_MASTER_PORT_NUMBER=\${REDIS_SENTINEL_INFO[1]}
fi

sentinel_conf_set "sentinel monitor" "mymaster "$REDIS_MASTER_HOST" "$REDIS_MASTER_PORT_NUMBER" 2"

add_known_sentinel() {
    hostname="$1"
    ip="$2"

    if [[ -n "$hostname" && -n "$ip" && "$hostname" != "$HOSTNAME" ]]; then
        sentinel_conf_add "sentinel known-sentinel mymaster $(get_full_hostname "$hostname") $(get_port "$hostname" "SENTINEL") $(host_id "$hostname")"
    fi 
}
add_known_replica() {
    hostname="$1"
    ip="$2"

    if [[ -n "$ip" && "$(get_full_hostname "$hostname")" != "$REDIS_MASTER_HOST" ]]; then
        sentinel_conf_add "sentinel known-replica mymaster $(get_full_hostname "$hostname") $(get_port "$hostname" "REDIS")"
    fi
}

# Add available hosts on the network as known replicas & sentinels
for node in $(seq 0 $((3-1))); do
    hostname="redis-node-$node"
    ip="$(getent hosts "$hostname.$HEADLESS_SERVICE" | awk '{ print $1 }')"
    add_known_sentinel "$hostname" "$ip"
    add_known_replica "$hostname" "$ip"
done
    
echo "" >> /opt/bitnami/redis-sentinel/etc/sentinel.conf
echo "sentinel announce-hostnames yes" >> /opt/bitnami/redis-sentinel/etc/sentinel.conf
echo "sentinel resolve-hostnames yes" >> /opt/bitnami/redis-sentinel/etc/sentinel.conf
echo "sentinel announce-port $SERVPORT" >> /opt/bitnami/redis-sentinel/etc/sentinel.conf
echo "sentinel announce-ip $(get_full_hostname "$HOSTNAME")" >> /opt/bitnami/redis-sentinel/etc/sentinel.conf
exec redis-server /opt/bitnami/redis-sentinel/etc/sentinel.conf --sentinel`,
        'prestop-sentinel.sh': `#!/bin/bash

. /opt/bitnami/scripts/libvalidations.sh
. /opt/bitnami/scripts/libos.sh

HEADLESS_SERVICE="redis-headless.default.svc.cluster.local"
SENTINEL_SERVICE_ENV_NAME=REDIS_SERVICE_PORT_TCP_SENTINEL
SENTINEL_SERVICE_PORT=$\{!SENTINEL_SERVICE_ENV_NAME}

get_full_hostname() {
    hostname="$1"
    echo "\${hostname}.\${HEADLESS_SERVICE}"
}
run_sentinel_command() {
    if is_boolean_yes "$REDIS_SENTINEL_TLS_ENABLED"; then
        redis-cli -h "$REDIS_SERVICE" -p "$SENTINEL_SERVICE_PORT" --tls --cert "$REDIS_SENTINEL_TLS_CERT_FILE" --key "$REDIS_SENTINEL_TLS_KEY_FILE" --cacert "$REDIS_SENTINEL_TLS_CA_FILE" sentinel "$@"
    else
        redis-cli -h "$REDIS_SERVICE" -p "$SENTINEL_SERVICE_PORT" sentinel "$@"
    fi
}
failover_finished() {
  REDIS_SENTINEL_INFO=($(run_sentinel_command get-master-addr-by-name "mymaster"))
  REDIS_MASTER_HOST="\${REDIS_SENTINEL_INFO[0]}"
  [[ "$REDIS_MASTER_HOST" != "$(get_full_hostname $HOSTNAME)" ]]
}

REDIS_SERVICE="redis.default.svc.cluster.local"

# redis-cli automatically consumes credentials from the REDISCLI_AUTH variable
[[ -n "$REDIS_PASSWORD" ]] && export REDISCLI_AUTH="$REDIS_PASSWORD"
[[ -f "$REDIS_PASSWORD_FILE" ]] && export REDISCLI_AUTH="$(< "\${REDIS_PASSWORD_FILE}")"

if ! failover_finished; then
    echo "I am the master pod and you are stopping me. Starting sentinel failover"
    # if I am the master, issue a command to failover once and then wait for the failover to finish
    run_sentinel_command failover "mymaster"
    if retry_while "failover_finished" "20" 1; then
        echo "Master has been successfuly failed over to a different pod."
        exit 0
    else
        echo "Master failover failed"
        exit 1
    fi
else
    exit 0
fi`,
        'prestop-redis.sh': `#!/bin/bash

. /opt/bitnami/scripts/libvalidations.sh
. /opt/bitnami/scripts/libos.sh

run_redis_command() {
    if is_boolean_yes "$REDIS_TLS_ENABLED"; then
        redis-cli -h 127.0.0.1 -p "$REDIS_TLS_PORT" --tls --cert "$REDIS_TLS_CERT_FILE" --key "$REDIS_TLS_KEY_FILE" --cacert "$REDIS_TLS_CA_FILE" "$@"
    else
        redis-cli -h 127.0.0.1 -p \${REDIS_PORT} "$@"
    fi
}
failover_finished() {
    REDIS_ROLE=$(run_redis_command role | head -1)
    [[ "$REDIS_ROLE" != "master" ]]
}

# redis-cli automatically consumes credentials from the REDISCLI_AUTH variable
[[ -n "$REDIS_PASSWORD" ]] && export REDISCLI_AUTH="$REDIS_PASSWORD"
[[ -f "$REDIS_PASSWORD_FILE" ]] && export REDISCLI_AUTH="$(< "\${REDIS_PASSWORD_FILE}")"

if ! failover_finished; then
    echo "Waiting for sentinel to run failover for up to 20s"
    retry_while "failover_finished" "20" 1
else
    exit 0
fi`,
      },
    });

    const headlessSvc = new k8s.KubeService(this, 'redis-headless', {
      metadata: {
        name: `${name}-headless`,
        labels: {
          name: name,

          instance: name,

        },
      },
      spec: {
        type: 'ClusterIP',
        clusterIp: 'None',
        publishNotReadyAddresses: true,
        ports: [
          {
            name: 'tcp-redis',
            port: 6379,
            targetPort: k8s.IntOrString.fromString('redis'),
          },
          {
            name: 'tcp-sentinel',
            port: 26379,
            targetPort: k8s.IntOrString.fromString('redis-sentinel'),
          },
        ],
        selector: {
          name: name,
          instance: name,
        },
      },
    });

    new k8s.KubeService(this, 'redis-svc', {
      metadata: {
        name: name,
        labels: {
          name: name,

          instance: name,

          component: 'node',
        },
      },
      spec: {
        type: 'ClusterIP',
        ports: [
          {
            name: 'tcp-redis',
            port: 6379,
            targetPort: k8s.IntOrString.fromNumber(6379),
            nodePort: undefined,
          },
          {
            name: 'tcp-sentinel',
            port: 26379,
            targetPort: k8s.IntOrString.fromNumber(26379),
            nodePort: undefined,
          },
        ],
        selector: {
          name: name,
          instance: name,
          component: 'node',
        },
      },
    });

    new k8s.KubeStatefulSet(this, 'redis-node', {
      metadata: {
        name: `${name}-node`,
        labels: {
          name: name,

          instance: name,

          component: 'node',
        },
      },
      spec: {
        replicas: opts.replicas ? opts.replicas : 3,
        selector: {
          matchLabels: {
            name: name,
            instance: name,
            component: 'node',
          },
        },
        serviceName: headlessSvc.metadata.name as string,
        updateStrategy: {
          rollingUpdate: {},
          type: 'RollingUpdate',
        },
        template: {
          metadata: {
            labels: {
              name: name,
              instance: name,
              component: 'node',
            },
          },
          spec: {
            securityContext: {
              fsGroup: 1001,
            },
            serviceAccountName: sa.metadata.name,
            affinity: {
              podAntiAffinity: {
                preferredDuringSchedulingIgnoredDuringExecution: [{
                  podAffinityTerm: {
                    labelSelector: {
                      matchLabels: {
                        name: name,
                        instance: name,
                        component: 'node',
                      },
                    },
                    topologyKey: 'kubernetes.io/hostname',
                  },
                  weight: 1,
                }],
              },
            },
            terminationGracePeriodSeconds: 30,
            containers: [
              {
                name: 'redis',
                image: opts.redisImage ? opts.redisImage : 'docker.io/bitnami/redis-sentinel:6.2.6-debian-10-r49',
                imagePullPolicy: 'IfNotPresent',
                securityContext: {
                  runAsUser: 1001,
                },
                command: ['/bin/bash'],
                args: [
                  '-c',
                  '/opt/bitnami/scripts/start-scripts/start-node.sh',
                ],
                env: [
                  {
                    name: 'BITNAMI_DEBUG',
                    value: 'false',
                  },
                  {
                    name: 'REDIS_MASTER_PORT_NUMBER',
                    value: '6379',
                  },
                  {
                    name: 'ALLOW_EMPTY_PASSWORD',
                    value: 'no',
                  },
                  {
                    name: 'REDIS_PASSWORD',
                    valueFrom: {
                      secretKeyRef: {
                        name: secret.metadata.name,
                        key: 'redis-password',
                      },
                    },
                  },
                  {
                    name: 'REDIS_MASTER_PASSWORD',
                    valueFrom: {
                      secretKeyRef: {
                        name: secret.metadata.name,
                        key: 'redis-password',
                      },
                    },
                  },
                  {
                    name: 'REDIS_TLS_ENABLED',
                    value: 'no',
                  },
                  {
                    name: 'REDIS_PORT',
                    value: '6379',
                  },
                  {
                    name: 'REDIS_DATA_DIR',
                    value: '/data',
                  },
                ],
                ports: [{
                  name: 'redis',
                  containerPort: 6379,
                }],
                livenessProbe: {
                  initialDelaySeconds: 20,
                  periodSeconds: 5,
                  timeoutSeconds: 5,
                  successThreshold: 1,
                  failureThreshold: 5,
                  exec: {
                    command: [
                      'sh',
                      '-c',
                      '/health/ping_liveness_local.sh 5',
                    ],
                  },
                },
                readinessProbe: {
                  initialDelaySeconds: 20,
                  periodSeconds: 5,
                  timeoutSeconds: 1,
                  successThreshold: 1,
                  failureThreshold: 5,
                  exec: {
                    command: [
                      'sh',
                      '-c',
                      '/health/ping_readiness_local.sh 5',
                    ],
                  },
                },
                resources: {
                  limits: {},
                  requests: {},
                },
                volumeMounts: [
                  {
                    name: 'start-scripts',
                    mountPath: '/opt/bitnami/scripts/start-scripts',
                  },
                  {
                    name: 'health',
                    mountPath: '/health',
                  },
                  {
                    name: 'redis-data',
                    mountPath: '/data',
                  },
                  {
                    name: 'config',
                    mountPath: '/opt/bitnami/redis/mounted-etc',
                  },
                  {
                    name: 'redis-tmp-conf',
                    mountPath: '/opt/bitnami/redis/etc',
                  },
                  {
                    name: 'tmp',
                    mountPath: '/tmp',
                  },
                ],
                lifecycle: {
                  preStop: {
                    exec: {
                      command: [
                        '/bin/bash',
                        '-c',
                        '/opt/bitnami/scripts/start-scripts/prestop-redis.sh',
                      ],
                    },
                  },
                },
              },
              {
                name: 'sentinel',
                image: opts.redisImage ? opts.redisImage : 'docker.io/bitnami/redis-sentinel:6.2.6-debian-10-r49',
                imagePullPolicy: 'IfNotPresent',
                securityContext: {
                  runAsUser: 1001,
                },
                command: ['/bin/bash'],
                args: [
                  '-c',
                  '/opt/bitnami/scripts/start-scripts/start-sentinel.sh',
                ],
                env: [
                  {
                    name: 'BITNAMI_DEBUG',
                    value: 'false',
                  },
                  {
                    name: 'REDIS_PASSWORD',
                    valueFrom: {
                      secretKeyRef: {
                        name: secret.metadata.name,
                        key: 'redis-password',
                      },
                    },
                  },
                  {
                    name: 'REDIS_SENTINEL_TLS_ENABLED',
                    value: 'no',
                  },
                  {
                    name: 'REDIS_SENTINEL_PORT',
                    value: '26379',
                  },
                ],
                ports: [{
                  name: 'redis-sentinel',
                  containerPort: 26379,
                }],
                livenessProbe: {
                  initialDelaySeconds: 20,
                  periodSeconds: 5,
                  timeoutSeconds: 5,
                  successThreshold: 1,
                  failureThreshold: 5,
                  exec: {
                    command: [
                      'sh',
                      '-c',
                      '/health/ping_sentinel.sh 5',
                    ],
                  },
                },
                readinessProbe: {
                  initialDelaySeconds: 20,
                  periodSeconds: 5,
                  timeoutSeconds: 1,
                  successThreshold: 1,
                  failureThreshold: 5,
                  exec: {
                    command: [
                      'sh',
                      '-c',
                      '/health/ping_sentinel.sh 5',
                    ],
                  },
                },
                lifecycle: {
                  preStop: {
                    exec: {
                      command: [
                        '/bin/bash',
                        '-c',
                        '/opt/bitnami/scripts/start-scripts/prestop-sentinel.sh',
                      ],
                    },
                  },
                },
                resources: {
                  limits: {},
                  requests: {},
                },
                volumeMounts: [
                  {
                    name: 'start-scripts',
                    mountPath: '/opt/bitnami/scripts/start-scripts',
                  },
                  {
                    name: 'health',
                    mountPath: '/health',
                  },
                  {
                    name: 'redis-data',
                    mountPath: '/data',
                  },
                  {
                    name: 'config',
                    mountPath: '/opt/bitnami/redis-sentinel/mounted-etc',
                  },
                  {
                    name: 'sentinel-tmp-conf',
                    mountPath: '/opt/bitnami/redis-sentinel/etc',
                  },
                ],
              },
            ],
            nodeSelector: opts.nodeSelector,
            tolerations: opts.tolerations,
            volumes: [
              {
                name: 'start-scripts',
                configMap: {
                  name: scriptsCm.metadata.name,
                  defaultMode: 0o755,
                },
              },
              {
                name: 'health',
                configMap: {
                  name: healthCm.metadata.name,
                  defaultMode: 0o755,
                },
              },
              {
                name: 'config',
                configMap: {
                  name: configCm.metadata.name,
                },
              },
              {
                name: 'sentinel-tmp-conf',
                emptyDir: {},
              },
              {
                name: 'redis-tmp-conf',
                emptyDir: {},
              },
              {
                name: 'tmp',
                emptyDir: {},
              },
            ],
          },
        },
        volumeClaimTemplates: [{
          metadata: {
            name: 'redis-data',
            labels: {
              name: name,
              instance: name,
              component: 'node',
            },
          },
          spec: {
            storageClassName: storageClass.metadata.name,
            accessModes: ['ReadWriteOnce'],
            resources: {
              requests: {
                storage: k8s.IntOrString.fromString(opts.volumeSize),
              },
            },
          },
        }],
      },
    });

  }
}
