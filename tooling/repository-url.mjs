const githubSshPrefix = "git@github.com:";
const githubSshUrlPrefix = "ssh://git@github.com/";

function canonicalGitHubHttps(pathname) {
  const repository = pathname.replace(/^\/+|\/+$/g, "");
  if (!repository) throw new Error("origin must identify a GitHub repository");
  return `https://github.com/${repository.endsWith(".git") ? repository : `${repository}.git`}`;
}

export function credentialFreeRemote(value) {
  if (value.startsWith(githubSshPrefix)) return canonicalGitHubHttps(value.slice(githubSshPrefix.length));
  if (value.startsWith(githubSshUrlPrefix)) return canonicalGitHubHttps(value.slice(githubSshUrlPrefix.length));
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("origin must be a credential-free HTTPS or GitHub SSH URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("origin must be a credential-free HTTPS or GitHub SSH URL");
  }
  return canonicalGitHubHttps(url.pathname);
}
