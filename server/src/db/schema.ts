import { pgTable, uuid, varchar, integer, bigint, boolean, decimal, index, jsonb, timestamp, text } from 'drizzle-orm/pg-core';
import type { FloorPlan, Point2D } from '../types';

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  location: jsonb('location').$type<{ lat: number; lng: number; address: string }>().notNull(),
  total_floors: integer('total_floors').notNull(),
  amenities: jsonb('amenities').$type<string[]>().default([]),
  thumbnail_url: text('thumbnail_url'),
  // Baked lightmapped GLB (pipeline/bake), served from ASSETS_PATH. Null = procedural slabs only.
  model_url: text('model_url'),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

export const floors = pgTable('floors', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  floor_number: integer('floor_number').notNull(),
  label: varchar('label', { length: 100 }),
  floor_height: decimal('floor_height', { precision: 4, scale: 2 }).notNull().default('3.00'),
  svg_outline: text('svg_outline').notNull(),
  // Engineered plan (FloorPlan) from an IFC import. Served separately: it can be large.
  plan: jsonb('plan').$type<FloorPlan>(),
});

export const units = pgTable('units', {
  id: uuid('id').primaryKey().defaultRandom(),
  floor_id: uuid('floor_id').references(() => floors.id, { onDelete: 'cascade' }).notNull(),
  unit_code: varchar('unit_code', { length: 20 }).notNull(),
  polygon: jsonb('polygon').$type<Point2D[]>().notNull(),
  area_sqm: decimal('area_sqm', { precision: 6, scale: 2 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('available'),
  // Integer minor units (halalas/fils); divide by 100 for display.
  price: bigint('price', { mode: 'number' }).notNull(),
  facing: varchar('facing', { length: 5 }),
  bedrooms: integer('bedrooms').notNull(),
  bathrooms: integer('bathrooms').notNull(),
  reserved_until: timestamp('reserved_until'),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

// Sales staff. role 'admin' can manage agents and upload prices; 'agent' handles units and holds.
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 200 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  role: varchar('role', { length: 10 }).notNull().default('agent'),
  password_hash: text('password_hash').notNull(), // scrypt: salt$hash (hex)
  active: boolean('active').notNull().default(true),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

// Login sessions. Only a SHA-256 of the bearer token is stored, so a DB leak doesn't leak sessions.
export const sessions = pgTable('sessions', {
  token_hash: varchar('token_hash', { length: 64 }).primaryKey(),
  agent_id: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }).notNull(),
  expires_at: timestamp('expires_at').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

// Who changed what, for every sales-relevant change. agent_id null = system / API key.
export const unitEvents = pgTable('unit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  unit_id: uuid('unit_id').references(() => units.id, { onDelete: 'cascade' }).notNull(),
  agent_id: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 20 }).notNull(), // 'status' | 'price'
  from_value: text('from_value'),
  to_value: text('to_value'),
  at: timestamp('at').defaultNow().notNull(),
}, t => ({ byUnit: index('unit_events_unit_idx').on(t.unit_id, t.at) }));

// A buyer asking to hold a unit. The unit stays available until an agent reserves it.
export const holdRequests = pgTable('hold_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  unit_id: uuid('unit_id').references(() => units.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  phone: varchar('phone', { length: 30 }).notNull(),
  note: varchar('note', { length: 500 }),
  status: varchar('status', { length: 12 }).notNull().default('open'), // open | contacted | reserved | dismissed
  handled_by: uuid('handled_by').references(() => agents.id, { onDelete: 'set null' }),
  created_at: timestamp('created_at').defaultNow().notNull(),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
}, t => ({ byStatus: index('hold_requests_status_idx').on(t.status, t.created_at) }));

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  unit_id: uuid('unit_id').references(() => units.id, { onDelete: 'cascade' }).notNull(),
  room_type: varchar('room_type', { length: 50 }).notNull(),
  polygon: jsonb('polygon').$type<Point2D[]>().notNull(),
  area_sqm: decimal('area_sqm', { precision: 5, scale: 2 }),
  label: varchar('label', { length: 100 }),
});
