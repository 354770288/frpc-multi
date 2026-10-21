/** Preserve bare IPv6; only host:decimal-port has an unambiguous single colon. */
export function probeEndpointHost(endpoint: string): string {
  const firstColon = endpoint.indexOf(':');
  return firstColon > 0 &&
    firstColon === endpoint.lastIndexOf(':') &&
    /^\d+$/.test(endpoint.slice(firstColon + 1))
    ? endpoint.slice(0, firstColon)
    : endpoint;
}
