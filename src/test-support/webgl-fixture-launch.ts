/**
 * Chromium launch arguments for e2e suites whose assertions need a live WebGL
 * context but do not test GPU backend selection.
 *
 * Chromium's automatic backend tries the platform GPU first and then falls back
 * to SwiftShader. During that startup the first WebGL context can fail
 * transiently (`ContextResult::kTransientFailure: Failed to send
 * GpuControl.CreateCommandBuffer`); `getContext('webgl2')` then returns null.
 * On macOS CI this made fixture workers throw before reporting, so suites hit
 * their readiness timeouts. These suites end up on SwiftShader either way, so
 * selecting it explicitly removes the race without changing the renderer they
 * measure. Production launches keep the automatic backend.
 */
export const WEBGL_FIXTURE_LAUNCH_ARGS: readonly string[] = ["--use-angle=swiftshader"];
