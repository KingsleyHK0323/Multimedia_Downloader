// OpenAI-Codex_format_architecture: fail closed when tag-rule protection cannot be proven.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO = 'KingsleyHK0323/Multimedia_Downloader';
const RULESET_ID = 27823531;
export function assertTagProtection(rule, repo = REPO) {
  const refs = rule?.conditions?.ref_name;
  const types = Array.isArray(rule?.rules) ? rule.rules.map(item => item?.type) : [];
  if (repo !== REPO || rule?.id !== RULESET_ID || rule?.source !== REPO ||
      rule.source_type !== 'Repository' || rule.target !== 'tag' ||
      rule.enforcement !== 'active' || !refs ||
      !Array.isArray(refs.include) || refs.include.length !== 1 || refs.include[0] !== 'refs/tags/v*' ||
      !Array.isArray(refs.exclude) || refs.exclude.length !== 0 ||
      !['deletion', 'non_fast_forward', 'update'].every(type => types.includes(type)) ||
      rule.current_user_can_bypass !== 'never' ||
      (Object.hasOwn(rule, 'bypass_actors') &&
       (!Array.isArray(rule.bypass_actors) || rule.bypass_actors.length !== 0))) {
    throw new Error('Cannot prove version-tag rules protect this automation token.');
  }
  // The API may hide bypass actors from tokens without ruleset write access.
  return { bypassActorsVisible: Object.hasOwn(rule, 'bypass_actors') };
}
export function verifyTagProtection() {
  if (process.env.GITHUB_REPOSITORY !== REPO || !process.env.GH_TOKEN) {
    throw new Error('Expected a repository-scoped GitHub token.');
  }
  const data = execFileSync('gh', ['api',
    'repos/' + REPO + '/rulesets/' + RULESET_ID + '?includes_parents=true'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1_000_000 });
  return assertTagProtection(JSON.parse(data));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = verifyTagProtection();
    if (!result.bypassActorsVisible) console.log('::notice::Other actors with tag-rule bypass are not visible to this token.');
  } catch (error) {
    console.error('::error::Version-tag protection cannot be verified.');
    process.exitCode = 1;
  }
}
