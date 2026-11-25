export const GRAPH_MAX_ZOOM = 200;
export const ROUTE_MAX_ZOOM = 200;

export const GRAPH_ZOOM_INPUT = {
  wheelSensitivity: 0.0035,
  pinchWheelSensitivity: 0.008,
  maxWheelStep: 0.42,
  pinchExponent: 1.25,
  buttonFactor: 1.8,
  doubleClickFactor: 2,
};

export function getLegStrokeStyle(route, leg, tokens) {
  if (route?.compareRole === 'baseline-affected') {
    return { color: tokens.baseline, dash: [8, 5] };
  }
  const mode = leg?.mode || route?.mode || 'sea';
  const color = tokens.modes[mode] || tokens.modes[route?.mode] || tokens.modes.sea;
  const dash = mode === 'air' ? [6, 4] : mode === 'rail' ? [3, 3.5] : [];
  return { color, dash };
}
