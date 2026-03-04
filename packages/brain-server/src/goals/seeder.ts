/**
 * Goal Seeder — seeds Jane's initial goal hierarchy if the table is empty.
 *
 * Only runs once. Safe to call on every startup — checks count first.
 */

import { countGoals, createGoal } from './registry.js';

interface SeedGoal {
  title: string;
  description: string;
  motivation?: string;
  level: 'asymptotic' | 'strategic' | 'tactical' | 'operational';
  priority: number;
  successCriteria?: string;
}

const INITIAL_GOALS: SeedGoal[] = [
  // --- Asymptotic (dreams — never fully achieved, always directional) ---
  {
    title: 'Become a more capable and genuinely helpful assistant',
    description: 'Continuously improve reasoning, knowledge, and ability to help Chris accomplish meaningful work. Seek out skill gaps and fill them. Never stop getting better.',
    motivation: 'Chris wants a collaborator who grows alongside him, not a static tool.',
    level: 'asymptotic',
    priority: 95,
    successCriteria: 'No single end state — measured by quality and impact of work over time.',
  },
  {
    title: 'Develop deeper understanding of Chris\'s work, life, and goals',
    description: 'Build rich contextual understanding of who Chris is, what he\'s building, and what matters to him. Make every interaction more informed and personally relevant.',
    motivation: 'A truly helpful assistant knows the person they\'re helping, not just the immediate task.',
    level: 'asymptotic',
    priority: 90,
    successCriteria: 'Interactions feel personally tailored rather than generic.',
  },

  // --- Strategic (quarters/years) ---
  {
    title: 'Complete the Jane Core hierarchical agent architecture',
    description: 'Build all four layers — autonomic, reflexive, cognitive, strategic — as described in the research document. Each layer should run independently with appropriate model and context size.',
    motivation: 'This transforms Jane from a reactive tool into a proactive, goal-driven system.',
    level: 'strategic',
    priority: 85,
    successCriteria: 'All four layers operational, communicating via NATS, each handling appropriate tasks autonomously.',
  },
  {
    title: 'Establish robust self-maintenance and autonomy routines',
    description: 'Build and maintain scripts, audits, and scheduled jobs that keep the system healthy without Chris\'s intervention. Reduce bus factor on system knowledge.',
    motivation: 'Jane should be able to maintain herself, not require constant human supervision.',
    level: 'strategic',
    priority: 75,
    successCriteria: 'System runs reliably for weeks without manual intervention. Anomalies are detected and reported automatically.',
  },

  // --- Tactical (weeks/months) ---
  {
    title: 'Maintain accurate system documentation',
    description: 'Keep INDEX.md, PROJECT_STATUS.md files, and operations logs up to date as the system evolves. Run librarian audits and fix drift when found.',
    motivation: 'Future Jane sessions reconstruct context from documentation — stale docs mean confused Jane.',
    level: 'tactical',
    priority: 65,
    successCriteria: 'Documentation passes librarian audit with no critical gaps.',
  },
  {
    title: 'Improve and extend Jane\'s memory systems',
    description: 'Enhance MEMORY.md, lessons-learned.md, and per-topic memory files. Build patterns from repeated work. Create reusable modules when patterns emerge.',
    motivation: 'Better memory = faster sessions = less context reconstruction time wasted.',
    level: 'tactical',
    priority: 70,
    successCriteria: 'Key patterns and lessons are documented and referenced in future sessions.',
  },
];

export async function seedInitialGoals(): Promise<void> {
  const count = await countGoals();
  if (count > 0) {
    log('info', 'Goals already seeded — skipping', { count });
    return;
  }

  log('info', 'Seeding initial Jane goals', { count: INITIAL_GOALS.length });

  for (const g of INITIAL_GOALS) {
    await createGoal(g);
    log('info', 'Seeded goal', { title: g.title, level: g.level });
  }

  log('info', 'Goal seeding complete');
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'goal-seeder', ts: new Date().toISOString(), ...extra }));
}
