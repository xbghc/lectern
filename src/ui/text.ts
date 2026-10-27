/** English count labels shared by the extension and app. */
export const quantity = (value: number, singular: string, plural = `${singular}s`): string =>
  `${value} ${value === 1 ? singular : plural}`;
