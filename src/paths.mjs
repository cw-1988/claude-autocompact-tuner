import { join } from 'node:path';
import { homedir } from 'node:os';

export const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
export const projectsDir = join(configDir, 'projects');
export const settingsFile = join(configDir, 'settings.json');
export const dataDir = process.env.COMPACT_TUNER_DIR ?? join(configDir, 'compact-tuner');
export const sessionsFile = join(dataDir, 'sessions.jsonl');
export const stateFile = join(dataDir, 'state.json');
export const tasksFile = join(dataDir, 'tasks.json');
