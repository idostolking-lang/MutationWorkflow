/**
 * Convert a URL glob such as `http://localhost:3000/**` or `**\/admin/**` into a RegExp.
 * `**` matches any characters including `/`; `*` matches anything except `/`; `?` matches one
 * character.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*';
        i += 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (ch === '?') {
      pattern += '[^/]';
    } else if (ch !== undefined) {
      pattern += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesAnyGlob(value: string, globs: ReadonlyArray<string>): boolean {
  return globs.some((glob) => globToRegExp(glob).test(value));
}
