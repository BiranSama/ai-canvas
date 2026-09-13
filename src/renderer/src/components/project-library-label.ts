export function projectLibraryLocationLabel(value: string): string {
  const segments = value.replaceAll('/', '\\').split('\\').map((segment) => segment.trim()).filter(Boolean)
  const leaf = segments.at(-1)
  if (leaf === undefined || /^(?:projects?|项目)$/i.test(leaf)) return '默认项目位置'
  return leaf
}
