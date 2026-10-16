import type { Facing, Point2D, RoomType, UnitStatus } from '../types';

// Pure data generator (no DB access) so it can be reused by seed and tests.
// Floor plan is 40m x 20m: 4 units along the north edge, 4 along the south edge, 4m corridor between.

export interface SampleRoom { type: RoomType; label: string; polygon: Point2D[]; area_sqm: number }
export interface SampleUnit {
  unit_code: string; polygon: Point2D[]; area_sqm: number; status: UnitStatus;
  price: number; facing: Facing; bedrooms: number; bathrooms: number; rooms: SampleRoom[];
}
export interface SampleFloor {
  floor_number: number; label: string; floor_height: number; svg_outline: string; units: SampleUnit[];
}

const UNIT_W = 10;
const UNIT_D = 8;
const FLOOR_W = 40;
const FLOOR_D = 20;
const CORRIDOR = 4;

const rect = (x: number, y: number, w: number, h: number): Point2D[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const area = (w: number, h: number) => Math.round(w * h * 100) / 100;

// Deterministic PRNG so the seed is reproducible.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildRooms(x: number, y: number): SampleRoom[] {
  const mk = (type: RoomType, label: string, rx: number, ry: number, w: number, h: number): SampleRoom =>
    ({ type, label, polygon: rect(x + rx, y + ry, w, h), area_sqm: area(w, h) });
  return [
    mk('living', 'Living room', 0, 0, 5, 5),
    mk('kitchen', 'Kitchen', 5, 0, 5, 3),
    mk('bathroom', 'Bathroom', 5, 3, 5, 2),
    mk('bedroom', 'Master bedroom', 0, 5, 5, 3),
    mk('bedroom', 'Bedroom 2', 5, 5, 5, 3),
  ];
}

export function buildSampleFloors(floorCount = 12, blockLetter = 'A'): SampleFloor[] {
  const rand = mulberry32(42);
  const floors: SampleFloor[] = [];
  for (let n = 1; n <= floorCount; n++) {
    const units: SampleUnit[] = [];
    for (let i = 0; i < 8; i++) {
      const north = i < 4;
      const col = i % 4;
      const x = col * UNIT_W;
      const y = north ? 0 : UNIT_D + CORRIDOR + (FLOOR_D - 2 * UNIT_D - CORRIDOR);
      const r = rand();
      const status: UnitStatus = r < 0.5 ? 'available' : r < 0.75 ? 'reserved' : 'sold';
      const bedrooms = col === 0 || col === 3 ? 3 : 2;
      units.push({
        unit_code: `${blockLetter}-${n}${String(i + 1).padStart(2, '0')}`,
        polygon: rect(x, y, UNIT_W, UNIT_D),
        area_sqm: area(UNIT_W, UNIT_D),
        status,
        // minor units: base 650k SAR + 8k per floor, in halalas
        price: (650_000 + n * 8_000 + (bedrooms - 2) * 80_000) * 100,
        facing: north ? 'N' : 'S',
        bedrooms,
        bathrooms: bedrooms,
        rooms: buildRooms(x, y),
      });
    }
    floors.push({
      floor_number: n,
      label: n === 1 ? 'Ground' : `Level ${n}`,
      floor_height: 3,
      svg_outline: `M0 0 L${FLOOR_W} 0 L${FLOOR_W} ${FLOOR_D} L0 ${FLOOR_D} Z`,
      units,
    });
  }
  return floors;
}
