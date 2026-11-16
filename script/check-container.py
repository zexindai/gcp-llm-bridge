#!/usr/bin/env python3
"""Check the actual image entrypoint without Google access or published ports."""
import json
import secrets
import subprocess
import time

name = 'gcp-llm-bridge-check-' + secrets.token_hex(5)

def docker(*args, check=True):
    return subprocess.run(['docker', *args], capture_output=True, text=True, check=check)

try:
    docker('run', '-d', '--name', name, '--network', 'none', '--read-only',
           '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
           '--health-interval', '1s', '--health-start-period', '0s',
           '-e', 'BRIDGE_API_KEY=container-test-bridge-1234567890abcdef',
           '-e', 'GOOGLE_API_KEY=container-test-google-9876543210abcdef',
           '-e', 'UPSTREAM_URL=https://aiplatform.googleapis.com/v1/projects/test-project-123/locations/global/endpoints/openapi/chat/completions',
           'gcp-llm-bridge:local')
    health = 'starting'
    for _ in range(20):
        health = docker('inspect', '--format', '{{.State.Health.Status}}', name).stdout.strip()
        if health == 'healthy':
            break
        time.sleep(0.5)
    if health != 'healthy':
        raise RuntimeError('Container did not become healthy')
    result = docker('exec', name, 'node', '--input-type=module', '-e', '''
import assert from 'node:assert/strict';
assert.notEqual(process.getuid(), 0);
const base = 'http://127.0.0.1:4000';
const health = await fetch(base + '/healthz');
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), {status:'ok'});
const denied = await fetch(base + '/v1/chat/completions', {method:'POST',body:'{}'});
assert.equal(denied.status, 401);
const models = await fetch(base + '/v1/models', {headers:{authorization:'Bearer ' + process.env.BRIDGE_API_KEY}});
assert.equal(models.status, 200);
assert.equal((await models.json()).data[0].id, 'google/gemini-4-argon');
console.log(JSON.stringify({node:process.version, uid:process.getuid(),health:health.status,unauthorized:denied.status,models:models.status}));
''')
    details = json.loads(docker('inspect', '--format', '{{json .HostConfig}}', name).stdout)
    assert details['ReadonlyRootfs']
    assert 'ALL' in details['CapDrop']
    assert details['NetworkMode'] == 'none'
    assert not details['PortBindings']
    print(result.stdout.strip())
    print('Container healthy; read-only filesystem; no network or published ports. Test container will be removed.')
except subprocess.CalledProcessError:
    raise SystemExit('Container validation failed. Inspect Docker availability and image build locally.')
finally:
    docker('rm', '-f', name, check=False)
