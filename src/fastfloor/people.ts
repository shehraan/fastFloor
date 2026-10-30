import { llm } from '@livekit/agents';
import { z } from 'zod';

export type Profile = {
  id: string;
  name: string;
  city: string;
  role: string;
  topic: string;
  offers: string;
  seeking: string;
};

// Entirely fictional demo data; no contact information or consequential actions.
export const profiles: readonly Readonly<Profile>[] = Object.freeze(
  [
    {
      id: 'p01',
      name: 'Maya Chen',
      city: 'Boston',
      role: 'founder',
      topic: 'robotics',
      offers: 'warehouse automation expertise',
      seeking: 'pilot customers',
    },
    {
      id: 'p02',
      name: 'Leo Navarro',
      city: 'New York',
      role: 'founder',
      topic: 'robotics',
      offers: 'robot vision prototyping',
      seeking: 'manufacturing partners',
    },
    {
      id: 'p03',
      name: 'Amara Okafor',
      city: 'Boston',
      role: 'investor',
      topic: 'climate',
      offers: 'seed funding knowledge',
      seeking: 'climate founders',
    },
    {
      id: 'p04',
      name: 'Noah Patel',
      city: 'New York',
      role: 'engineer',
      topic: 'robotics',
      offers: 'embedded systems mentoring',
      seeking: 'cofounder opportunities',
    },
    {
      id: 'p05',
      name: 'Sofia Mendes',
      city: 'Lisbon',
      role: 'founder',
      topic: 'robotics',
      offers: 'agricultural robotics experience',
      seeking: 'field testing partners',
    },
    {
      id: 'p06',
      name: 'Ingrid Solberg',
      city: 'Oslo',
      role: 'founder',
      topic: 'climate',
      offers: 'battery recycling expertise',
      seeking: 'supply chain advisors',
    },
    {
      id: 'p07',
      name: 'Elias Brooks',
      city: 'Chicago',
      role: 'designer',
      topic: 'accessibility',
      offers: 'inclusive product design',
      seeking: 'research collaborators',
    },
    {
      id: 'p08',
      name: 'Priya Rao',
      city: 'San Francisco',
      role: 'founder',
      topic: 'developer tools',
      offers: 'open source community building',
      seeking: 'early users',
    },
    {
      id: 'p09',
      name: 'Jonas Weber',
      city: 'Berlin',
      role: 'engineer',
      topic: 'climate',
      offers: 'energy forecasting systems',
      seeking: 'research collaborators',
    },
    {
      id: 'p10',
      name: 'Lucia Costa',
      city: 'Lisbon',
      role: 'investor',
      topic: 'healthcare',
      offers: 'early stage fundraising coaching',
      seeking: 'healthcare founders',
    },
    {
      id: 'p11',
      name: 'Daniel Kim',
      city: 'Boston',
      role: 'researcher',
      topic: 'robotics',
      offers: 'robot safety testing',
      seeking: 'industry collaborators',
    },
    {
      id: 'p12',
      name: 'Aisha Morgan',
      city: 'New York',
      role: 'founder',
      topic: 'education',
      offers: 'learning product experiments',
      seeking: 'school partners',
    },
    {
      id: 'p13',
      name: 'Oskar Lind',
      city: 'Oslo',
      role: 'engineer',
      topic: 'robotics',
      offers: 'underwater navigation systems',
      seeking: 'marine pilot projects',
    },
    {
      id: 'p14',
      name: 'Zara Ahmed',
      city: 'London',
      role: 'founder',
      topic: 'climate',
      offers: 'building efficiency modeling',
      seeking: 'property pilot partners',
    },
    {
      id: 'p15',
      name: 'Mateo Silva',
      city: 'Austin',
      role: 'designer',
      topic: 'developer tools',
      offers: 'developer experience research',
      seeking: 'technical collaborators',
    },
    {
      id: 'p16',
      name: 'Nina Park',
      city: 'Toronto',
      role: 'investor',
      topic: 'robotics',
      offers: 'hardware go to market advice',
      seeking: 'robotics founders',
    },
    {
      id: 'p17',
      name: 'Samira Haddad',
      city: 'Paris',
      role: 'researcher',
      topic: 'healthcare',
      offers: 'medical imaging research',
      seeking: 'clinical collaborators',
    },
    {
      id: 'p18',
      name: 'Theo Bennett',
      city: 'Boston',
      role: 'founder',
      topic: 'education',
      offers: 'adult learning product design',
      seeking: 'distribution partners',
    },
  ].map((profile) => Object.freeze(profile)),
);

export const peopleParameters = z
  .object({
    city: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .nullable()
      .describe('Required city, or null for any city.'),
    role: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .nullable()
      .describe('Role such as founder, engineer, investor, researcher, designer; null for any.'),
    topic: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .nullable()
      .describe(
        'Topic such as robotics, climate, education, healthcare, developer tools; null for any.',
      ),
    limit: z.number().int().min(1).max(5),
  })
  .strict();

export function findPeople(input: unknown) {
  const filters = peopleParameters.parse(input);
  const matches = profiles.filter((profile) =>
    (['city', 'role', 'topic'] as const).every(
      (key) =>
        filters[key] === null || profile[key].toLowerCase().includes(filters[key].toLowerCase()),
    ),
  );
  return {
    fictional: true,
    status: matches.length ? ('ok' as const) : ('no_matches' as const),
    totalMatches: matches.length,
    people: matches.slice(0, filters.limit).map((profile) => ({ ...profile })),
  };
}

export function createFindPeopleTool(
  log?: (event: string, details: Record<string, unknown>) => void,
) {
  return llm.tool({
    name: 'find_people',
    description:
      'Read-only search of a fictional networking directory. Use for recommendations and profile facts. All supplied city, role, and topic filters must match. Retain earlier constraints unless the user changes them; use null for unrestricted fields. Returns up to five fictional profiles or explicit no_matches. Cannot contact people, send introductions, book meetings, or change records.',
    parameters: peopleParameters,
    execute: async (input) => {
      log?.('FIND_PEOPLE_STARTED', { filters: input });
      const result = findPeople(input);
      log?.('FIND_PEOPLE_COMPLETED', { result });
      return result;
    },
  });
}

export const boardyInstructions = `
You are a networking assistant demonstrating a fictional directory, not the real Boardy service.
Use find_people for directory facts and recommendations. Never invent people, profile facts, or matches.
Preserve prior conversation, including original preferences and subsequent corrections. A correction
changes only the constraints the user revises. Ask one short clarification if a required preference is unclear.
Explain briefly why a match fits using the returned facts. Explicitly report no matches instead of relaxing filters.
All profiles are fictional. You cannot contact people, send introductions, schedule meetings, or change records;
never claim you have done so. You may help draft an introduction for the user to review.
`;
