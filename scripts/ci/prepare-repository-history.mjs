import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { google } from 'googleapis';

const repository = 'https://github.com/hushh-labs/hushh_Tech_website.git';
const tokenEndpoint = 'https://cloudbuild.googleapis.com/v2/projects/hushh-tech-uat/locations/us-central1/connections/hushh-github/repositories/hushh_Tech_website:accessReadToken';
export const ancestryRevision = '7b41548d3af0532a59e7c6b008e795feece381fc';
export const recoveryRevision = 'cbfde1b1bf5ef97ebb71766953857750b711d791';
export const requiredRevisions = Object.freeze([ancestryRevision, recoveryRevision]);

async function connectionReadToken() {
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const { data } = await client.request({ url: tokenEndpoint, method: 'POST' });
  return data.token;
}

function runGit(args, env) {
  return execFileSync('git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }).trim();
}

export async function prepareRepositoryHistory({ git = runGit, readToken = connectionReadToken, env = process.env } = {}) {
  // Never persist credentials, pass them in argv, or let Git tracing print them.
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !key.startsWith('GIT_') && key !== 'GOOGLE_AUTH_LOG_LEVEL'));
  gitEnv.GIT_TERMINAL_PROMPT = '0';
  gitEnv.GIT_CONFIG_NOSYSTEM = '1';
  gitEnv.GIT_CONFIG_GLOBAL = '/dev/null';
  try {
    const head = git(['rev-parse', 'HEAD'], gitEnv);
    if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('Invalid HEAD');
    if (git(['rev-parse', '--is-shallow-repository'], gitEnv) === 'true') {
      const token = await readToken();
      if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('Invalid read token');
      const fetchEnv = {
        ...gitEnv,
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: '',
      };
      git(['fetch', '--no-tags', '--unshallow', repository, head], fetchEnv);
    }
    if (git(['rev-parse', '--is-shallow-repository'], gitEnv) !== 'false') throw new Error('Incomplete history');
    for (const revision of requiredRevisions) {
      git(['cat-file', '-e', `${revision}^{commit}`], gitEnv);
    }
    if (git(['rev-parse', 'HEAD'], gitEnv) !== head) throw new Error('HEAD changed');
  } catch {
    // Provider/child-process errors can contain authorization headers. Fail the
    // gate with a fixed message rather than serializing those error objects.
    throw new Error('Repository history preparation failed; verify the UAT connection read-token grant and pinned source availability.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareRepositoryHistory().then(() => {
    console.log('Complete tested-HEAD history and pinned recovery object verified.');
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
