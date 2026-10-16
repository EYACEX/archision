import { db, pool } from './index';
import { projects, floors, units, rooms } from './schema';
import { buildSampleFloors } from './sampleProject';

async function seed() {
  // Wipe in FK order so the seed is re-runnable.
  await db.delete(rooms);
  await db.delete(units);
  await db.delete(floors);
  await db.delete(projects);

  const sample = buildSampleFloors(12);

  const [project] = await db.insert(projects).values({
    name: 'Al Noor Residences',
    location: { lat: 24.7136, lng: 46.6753, address: 'King Fahd Rd, Riyadh' },
    total_floors: sample.length,
    amenities: ['Pool', 'Gym', 'Underground parking', 'Concierge'],
  }).returning();

  for (const f of sample) {
    const [floor] = await db.insert(floors).values({
      project_id: project.id,
      floor_number: f.floor_number,
      label: f.label,
      floor_height: f.floor_height.toFixed(2),
      svg_outline: f.svg_outline,
    }).returning();

    for (const u of f.units) {
      const [unit] = await db.insert(units).values({
        floor_id: floor.id,
        unit_code: u.unit_code,
        polygon: u.polygon,
        area_sqm: u.area_sqm.toFixed(2),
        status: u.status,
        price: u.price,
        facing: u.facing,
        bedrooms: u.bedrooms,
        bathrooms: u.bathrooms,
        reserved_until: u.status === 'reserved' ? new Date(Date.now() + 3 * 864e5) : null,
      }).returning();

      await db.insert(rooms).values(u.rooms.map(r => ({
        unit_id: unit.id,
        room_type: r.type,
        polygon: r.polygon,
        area_sqm: r.area_sqm.toFixed(2),
        label: r.label,
      })));
    }
  }
  console.log(`Seeded "${project.name}" with ${sample.length} floors.`);
}

seed().then(() => pool.end()).catch(err => { console.error(err); process.exit(1); });
