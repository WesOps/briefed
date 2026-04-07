import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { simpleGit } from "simple-git";

export interface CorpusSpec {
  name: string;
  url: string;
  ref: string;
}

/** Default bench target: epic-stack pinned to a known-good commit. */
export const DEFAULT_CORPUS: CorpusSpec = {
  name: "epic-stack",
  url: "https://github.com/epicweb-dev/epic-stack.git",
  ref: "19eeb4ba358781ea447762e70403f7b78994db10",
};

/**
 * Shallow-clone a CorpusSpec into `<cacheRoot>/<name>` and check out its pinned ref.
 * If the directory already contains a .git dir at the expected ref, reuse it.
 * Returns the absolute path to the checkout.
 */
export async function ensureCorpus(spec: CorpusSpec, cacheRoot: string): Promise<string> {
  mkdirSync(cacheRoot, { recursive: true });
  const target = join(cacheRoot, spec.name);

  if (existsSync(join(target, ".git"))) {
    try {
      const git = simpleGit(target);
      const head = (await git.revparse(["HEAD"])).trim();
      if (head === spec.ref) return target;
      await git.checkout(spec.ref);
      return target;
    } catch {
      // fall through
    }
  }

  if (existsSync(target)) {
    return target;
  }

  const git = simpleGit();
  await git.clone(spec.url, target, ["--depth", "1", "--no-single-branch"]);
  const repo = simpleGit(target);
  try {
    await repo.checkout(spec.ref);
  } catch {
    await repo.fetch(["--unshallow"]);
    await repo.checkout(spec.ref);
  }
  return target;
}
