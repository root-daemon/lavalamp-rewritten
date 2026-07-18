export type ApprovalDecision = 'allow' | 'always' | 'deny';

export function approvalResponse(
  method: string,
  decision: ApprovalDecision,
  params: unknown,
): Record<string, unknown> {
  if (method === 'item/permissions/requestApproval') {
    const permissions = readPermissions(params);
    if (decision === 'deny') {
      return { permissions: {}, scope: 'turn' };
    }
    return {
      permissions,
      scope: decision === 'always' ? 'session' : 'turn',
    };
  }

  if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval'
  ) {
    return {
      decision:
        decision === 'allow'
          ? 'accept'
          : decision === 'always'
            ? 'acceptForSession'
            : 'decline',
    };
  }

  throw new Error(`Unsupported Codex server request: ${method}`);
}

function readPermissions(params: unknown): Record<string, unknown> {
  if (typeof params !== 'object' || params === null) {
    return {};
  }
  const permissions = (params as Record<string, unknown>).permissions;
  return typeof permissions === 'object' && permissions !== null
    ? (permissions as Record<string, unknown>)
    : {};
}
