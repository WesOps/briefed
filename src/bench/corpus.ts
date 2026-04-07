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
    const git = simpleGit(target);
    try {
      const head = (await git.revparse(["HEAD"])).trim();
      if (head === spec.ref) return target;
      await git.checkout(spec.ref);
      return target;
    } catch (e) {
      throw new Error(
        `Failed to reuse cached corpus at ${target} (pinned ${spec.name}@${spec.ref}): ${(e as Error).message}. Delete the directory and re-run to fetch a fresh copy.`,
      );
    }
  }

  if (existsSync(target)) {
    // Non-git directory escape hatch: user-supplied checkout. Pinned ref is NOT enforced.
    console.warn(
      `[corpus] ${target} exists but is not a git checkout; reusing as-is (pinned ref ${spec.ref} NOT enforced).`,
    );
    return target;
  }

  try {
    const git = simpleGit();
    await git.clone(spec.url, target, ["--depth", "1", "--no-single-branch"]);
  } catch (e) {
    throw new Error(
      `Failed to clone ${spec.name} from ${spec.url}: ${(e as Error).message}`,
    );
  }

  const repo = simpleGit(target);
  try {
    await repo.checkout(spec.ref);
  } catch {
    try {
      await repo.fetch(["--unshallow"]);
      await repo.checkout(spec.ref);
    } catch (e) {
      throw new Error(
        `Failed to check out ${spec.name}@${spec.ref} from ${spec.url} after unshallow: ${(e as Error).message}`,
      );
    }
  }
  return target;
}
