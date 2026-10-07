export interface GstIssue {
  path: string;
  message: string;
}

/** Thrown when engine input is invalid. Carries every problem found, not just the first. */
export class GstCalculationError extends Error {
  readonly code = 'GST_INVALID_INPUT' as const;
  readonly issues: readonly GstIssue[];

  constructor(issues: readonly GstIssue[]) {
    super(
      `Invalid GST calculation input: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    );
    this.name = 'GstCalculationError';
    this.issues = issues;
  }
}
