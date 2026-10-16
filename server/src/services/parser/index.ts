import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FloorPlan, ImportUnit, Point2D } from '../../types';

const DXF_SCRIPT = fileURLToPath(new URL('./dxf.py', import.meta.url));
const IFC_SCRIPT = fileURLToPath(new URL('./ifc.py', import.meta.url));

/** One floor plan as parsed from a DXF: metres, in the drawing's own origin. */
export interface ParsedPlan {
  source: string;
  outline: Point2D[];
  holes: Point2D[][];
  units: ImportUnit[];         // unit_code may contain '#' for the floor number
  warnings: string[];
}

export interface DxfOptions {
  units?: 'mm' | 'cm' | 'm' | 'in' | 'ft';
  north?: number;              // plan north, degrees clockwise from straight up
}

/** One storey of an IFC model: like a ParsedPlan, plus height and the engineered plan. */
export interface ParsedStorey {
  name: string;
  elevation: number;
  height: number;
  outline: Point2D[];
  holes: Point2D[][];
  units: ImportUnit[];
  plan: FloorPlan;
}

export interface ParsedIfc {
  source: string;
  north_deg: number;
  storeys: ParsedStorey[];
  warnings: string[];
}

/** Run the Python ezdxf parser on one DXF file. */
export function parseDxf(file: string, opts: DxfOptions = {}): Promise<ParsedPlan> {
  const args = [DXF_SCRIPT, file];
  if (opts.units) args.push('--units', opts.units);
  if (opts.north) args.push('--north', String(opts.north));
  return runParser<ParsedPlan>(args);
}

/** Run the Python IfcOpenShell parser on a whole IFC model (all storeys at once). */
export function parseIfc(file: string, opts: { cutHeight?: number } = {}): Promise<ParsedIfc> {
  const args = [IFC_SCRIPT, file];
  if (opts.cutHeight) args.push('--cut-height', String(opts.cutHeight));
  return runParser<ParsedIfc>(args);
}

function runParser<T>(args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    // spawn, never exec: the file path is passed as an argument, not through a shell.
    const child = spawn(process.env.PYTHON_BIN ?? 'python', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', e => reject(new Error(`Could not start Python (set PYTHON_BIN): ${e.message}`)));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(Buffer.concat(err).toString().trim() || `Parser exited with ${code}`));
      try {
        resolve(JSON.parse(Buffer.concat(out).toString()) as T);
      } catch {
        reject(new Error('Parser returned invalid JSON'));
      }
    });
  });
}
