import { PointerSensor, useSensor, useSensors } from '@dnd-kit/core';

/** Standard pointer-sensor setup used by config trees (5px activation distance). */
export function useDndSensors() {
  return useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
}
