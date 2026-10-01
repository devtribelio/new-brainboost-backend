/**
 * Which app a request / device belongs to. 'brainboost' is every build already in
 * the stores (no header); 'b2b' is the company app, which sends `x-app: b2b`.
 * Push delivery and the single-active-push-device rule are scoped by this value.
 */
export type DeviceApp = 'brainboost' | 'b2b';

export const DEVICE_APPS: readonly DeviceApp[] = ['brainboost', 'b2b'];

/** Header value → app. Anything other than an explicit `b2b` is the regular app. */
export function resolveDeviceApp(header: string | string[] | null | undefined): DeviceApp {
  const raw = Array.isArray(header) ? header[0] : header;
  return raw?.trim().toLowerCase() === 'b2b' ? 'b2b' : 'brainboost';
}
