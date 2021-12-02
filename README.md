# cdk8s-redis-sentinel

Replicated, password protected redis sentinel statefulset setup. Uses Bitnamis redis-sentinel helm chart as a reference.

## Example

```
  new Redis(chart, 'redis', {
    volumeSize: '10Gi',
    replicas: 2,
    volumeFsType: 'ext4',
    volumeType: 'io1',
    volumeIopsPerGb: '100',
    redisImage: 'test-image',
    redisPassword: 'dGVzdDIK', // base64 encoded
    nodeSelector: {
      test: 'test',
    },
    tolerations: [
      {
        key: 'test',
        operator: 'Equal',
        value: 'test',
      },
    ],
  });
```

## [`API.md`](API.md)


