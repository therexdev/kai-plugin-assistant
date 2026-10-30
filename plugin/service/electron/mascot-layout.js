"use strict";
const SIZE = { compact: { width: 248, height: 304 }, chat: { width: 660, height: 560 } };
// Matches the perched artwork's 430 SVG-unit descent (242 / 1440 scale)
// and the 39 DIP toolbar space beneath the free-standing robot.
const PERCH_LIFT = 111, SNAP_DISTANCE = 24, LIFT_THRESHOLD = 28;
const clamp = (n, min, max) => Math.max(min, Math.min(n, max));
function fitBounds(anchor, expanded, area) {
  const size = expanded ? SIZE.chat : SIZE.compact;
  const width = Math.min(size.width, area.width), height = Math.min(size.height, area.height);
  return { x: Math.round(clamp(anchor.x - width, area.x, area.x + area.width - width)),
    y: Math.round(clamp(anchor.y - height, area.y, area.y + area.height - height)), width, height };
}
function dragPlacement(drag, cursor, expanded, area) {
  const dx = cursor.x - drag.cursor.x, dy = cursor.y - drag.cursor.y;
  const lifted = drag.lifted || !drag.perched || dy < -LIFT_THRESHOLD;
  const floor = area.y + area.height;
  const anchor = { x: drag.anchor.x + dx,
    y: !lifted ? floor : drag.anchor.y + dy + (drag.perched ? PERCH_LIFT : 0) };
  const bounds = fitBounds(anchor, expanded, area);
  return { bounds, anchor, lifted, perched: !lifted || anchor.y >= floor - SNAP_DISTANCE,
    // The OS window always stays on screen. A little of the dangling body can
    // remain below the edge while being lifted out, without moving the head
    // away from the hand or passing off-screen bounds to Windows.
    offsetY: lifted ? clamp(anchor.y - bounds.y - bounds.height, 0, PERCH_LIFT) : 0 };
}
module.exports = { SIZE, PERCH_LIFT, SNAP_DISTANCE, LIFT_THRESHOLD, fitBounds, dragPlacement };
