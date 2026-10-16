// Single source of truth for shared server/client types.
// Server re-exports this file (server/src/types.ts).

export type UnitStatus = 'available' | 'sold' | 'reserved';
export type Facing = 'N' | 'S' | 'E' | 'W' | 'NE' | 'NW' | 'SE' | 'SW';
export type RoomType = 'bedroom' | 'living' | 'kitchen' | 'bathroom' | 'balcony' | 'storage';

export interface Point2D { x: number; y: number; }

export interface Media {
  type: 'image' | '360' | 'video';
  url: string;
  label?: string;
  is_primary?: boolean;
}

export interface Room {
  id: string;
  type: RoomType;
  polygon: Point2D[];
  area_sqm: number;
  label?: string;
}

export interface Unit {
  id: string;
  unit_code: string;           // "A-301"
  polygon: Point2D[];          // bounding polygon on floor plan (metres)
  area_sqm: number;
  status: UnitStatus;
  price: number;               // minor units (halalas/fils); divide by 100 for display
  facing: Facing;
  bedrooms: number;
  bathrooms: number;
  floor_number: number;
  rooms: Room[];
  media: Media[];
  reserved_until?: string;     // ISO date
}

export interface Floor {
  id: string;
  project_id: string;
  floor_number: number;
  label: string;
  floor_height: number;        // metres — ExtrudeGeometry depth
  svg_outline: string;         // SVG path string for the floor footprint
  has_plan?: boolean;          // an engineered plan exists: GET /api/floors/:id/plan
  units: Unit[];
}

/** [x, y] in metres, in the floor's coordinates (same frame as unit polygons). */
export type PlanPoint = [number, number];
/** A polygon: outer ring first, then holes. */
export type PlanPolygon = PlanPoint[][];

/** Engineered floor plan: a horizontal section of the BIM model (IFC import), drawn under the units. */
export interface FloorPlan {
  walls: PlanPolygon[];        // cut walls, columns, railings: drawn solid
  windows: PlanPolygon[];
  doors: PlanPolygon[];        // door leaves
  swings: PlanPoint[][];       // door swing arcs (polylines)
  furniture: PlanPolygon[];    // furniture, fittings, stairs below the cut: drawn in outline
  labels: { x: number; y: number; text: string; sub?: string }[];
}

export interface Project {
  id: string;
  name: string;
  location: { lat: number; lng: number; address: string };
  total_floors: number;
  floors: Floor[];
  amenities: string[];
  thumbnail_url?: string;
  model_url?: string;          // baked lightmapped GLB, relative to the API origin
  created_at: string;
}

export type ProjectSummary = Omit<Project, 'floors'>;

// Normalized import format. The DXF parser produces it today; the Revit/SketchUp plugins will
// send the same shape, so the importer never cares which tool drew the building.
// Geometry only — sales data (status, price, reservations) is never part of an import.
export interface ImportRoom {
  type: RoomType;
  label?: string;
  polygon: Point2D[];
  area_sqm: number;
}

export interface ImportUnit {
  unit_code: string;
  polygon: Point2D[];
  area_sqm: number;
  facing: Facing;
  bedrooms: number;
  bathrooms: number;
  rooms: ImportRoom[];
}

export interface ImportFloor {
  floor_number: number;
  label: string;
  floor_height: number;
  svg_outline: string;
  units: ImportUnit[];
  plan?: FloorPlan;            // IFC imports. Geometry, so a re-import replaces it (or clears it if absent)
}

export interface ProjectImport {
  name: string;
  location?: Project['location'];
  amenities?: string[];
  floors: ImportFloor[];
}

export interface ImportResult {
  project_id: string;
  floors: number;
  units_created: number;
  units_updated: number;
  units_removed: string[];     // unit codes
}

// WebSocket event payloads
export interface UnitStatusUpdate {
  project_id: string;
  unit_id: string;
  status: UnitStatus;
  reserved_until?: string;
  updated_by?: string;
}

// Socket.io event maps — status changes are written via PATCH /api/units/:id only;
// sockets are receive-only so public viewers can't change unit status.
export interface ServerToClientEvents {
  unit_updated: (payload: UnitStatusUpdate) => void;
}

export interface ClientToServerEvents {
  join_project: (projectId: string) => void;
  leave_project: (projectId: string) => void;
}

export const UNIT_STATUSES: readonly UnitStatus[] = ['available', 'sold', 'reserved'];
