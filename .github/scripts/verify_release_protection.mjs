// OpenAI-Codex_Fork_GitHub_REPO: fail closed on missing release protections.
import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';

const TAG_REF = 'refs/tags/v*';
const ENVIRONMENT = 'staged-release-publish';

function fail(message) {
  throw new Error(message);
}

export function validateProtection({ rulesets, environment, policies }) {
  if (!Array.isArray(rulesets) || !Array.isArray(policies) || !environment || typeof environment !== 'object') {
    fail('Protection settings response is incomplete.');
  }
  if (environment.name !== ENVIRONMENT) fail('The staged-release-publish environment is missing.');
  if (!Array.isArray(environment.protection_rules) || environment.protection_rules.some(rule => rule?.type !== 'branch_policy')) {
    fail('The publish environment must not require human approval, timers, or custom protection rules.');
  }
  const branchPolicy = environment.deployment_branch_policy;
  if (!branchPolicy || branchPolicy.protected_branches !== false || branchPolicy.custom_branch_policies !== true) {
    fail('The publish environment must use a custom tag policy only.');
  }
  if (policies.length !== 1 || policies[0]?.type !== 'tag' || policies[0]?.name !== 'v*') {
    fail('The publish environment must allow exactly the v* tag policy.');
  }

  const active = rulesets.filter(rule =>
    rule && rule.target === 'tag' &&
    (rule.enforcement === 'active' || rule.enforcement === 'enabled') &&
    Array.isArray(rule.conditions?.ref_name?.include) &&
    rule.conditions.ref_name.include.includes(TAG_REF) &&
    Array.isArray(rule.conditions?.ref_name?.exclude) &&
    rule.conditions.ref_name.exclude.length === 0
  );
  const requiredTypes = new Set(['update', 'deletion']);
  const matching = active.filter(rule => {
    const types = new Set(Array.isArray(rule.rules) ? rule.rules.map(item => item?.type) : []);
    return [...requiredTypes].every(type => types.has(type));
  });
  if (matching.length === 0) fail('An active refs/tags/v* ruleset must block tag updates and deletions.');

  // OpenAI-Codex: fail closed when the API withholds bypass configuration.
  for (const rule of matching) {
    if (!Array.isArray(rule.bypass_actors)) {
      fail('GitHub did not expose bypass_actors for the active tag ruleset; refusing release because bypass safety cannot be verified.');
    }
    if (rule.bypass_actors.length !== 0) fail('The tag protection ruleset has bypass actors.');
  }
  return [];
}

async function getJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    fail('GitHub protection API request failed with HTTP ' + response.status + '.');
  }
  return response.json();
}

async function main() {
  try {
    const repository = process.env.GITHUB_REPOSITORY;
    const token = process.env.GH_TOKEN;
    if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) {
      fail('Repository or GitHub token is unavailable.');
    }
    const api = process.env.GITHUB_API_URL || 'https://api.github.com';
    const root = api.replace(/\/$/, '') + '/repos/' + repository;
    const listed = await getJson(root + '/rulesets?includes_parents=false&targets=tag&per_page=100', token);
    if (!Array.isArray(listed) || listed.length >= 100) fail('Tag ruleset list is invalid or exceeds the verified page limit.');
    const rulesets = await Promise.all(listed.map(item => getJson(root + '/rulesets/' + encodeURIComponent(item.id), token)));
    const environment = await getJson(root + '/environments/' + encodeURIComponent(ENVIRONMENT), token);
    const policyList = await getJson(root + '/environments/' + encodeURIComponent(ENVIRONMENT) + '/deployment-branch-policies?per_page=100', token);
    if (!Array.isArray(policyList.branch_policies) || policyList.total_count !== policyList.branch_policies.length || policyList.total_count >= 100) {
      fail('Deployment tag policy list is incomplete or exceeds the verified page limit.');
    }
    const policies = await Promise.all(policyList.branch_policies.map(item =>
      getJson(root + '/environments/' + encodeURIComponent(ENVIRONMENT) + '/deployment-branch-policies/' + encodeURIComponent(item.id), token)
    ));
    const warnings = validateProtection({ rulesets, environment, policies });
    for (const warning of warnings) {
      process.stderr.write('::warning::' + warning + '\n');
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '- Warning: ' + warning + '\n');
    }
    process.stdout.write('Required tag update/deletion rules and automatic v* deployment policy are active; no environment approval is configured.\n');
  } catch (error) {
    process.stderr.write('::error::' + error.message + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
