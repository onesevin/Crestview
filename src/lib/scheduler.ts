// src/lib/scheduler.ts

import Anthropic from '@anthropic-ai/sdk';
import { TaskPattern } from '@/types';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

interface ScheduleBlock {
  start_time: string;
  end_time: string;
  type: 'task' | 'break' | 'lunch';
  title: string;
  description?: string;
  estimated_duration: number;
}

export async function generateOptimalSchedule(
  taskDescriptions: string[],
  patterns: TaskPattern[] = [],
  date: string
): Promise<{
  blocks: ScheduleBlock[];
  suggestions: string[];
}> {
  const dayOfWeek = new Date(date).toLocaleDateString('en-US', { weekday: 'long' });
  
  // Build context about learned patterns
  const patternContext = patterns.length > 0
    ? `\n\nHistorical patterns from previous tasks:
${patterns.map(p => 
  `- Tasks matching "${p.task_keywords.join(', ')}" typically take ${p.average_duration} minutes (${(p.completion_rate * 100).toFixed(0)}% completion rate)`
).join('\n')}`
    : '';

  const prompt = `You are a productivity scheduling assistant. Generate an optimal 6-hour work schedule for ${dayOfWeek}, ${date}.

TASKS TO SCHEDULE:
${taskDescriptions.map((task, i) => `${i + 1}. ${task}`).join('\n')}
${patternContext}

REQUIREMENTS:
- Total work time: 6 hours (360 minutes)
- Start time: 9:00 AM
- End time: 3:00 PM (with breaks)
- Include healthy breaks for wellbeing:
  * Short breaks: 5-10 minutes every 60-90 minutes
  * Lunch break: 30 minutes around midday
- Schedule high-priority/complex tasks when energy is typically higher (morning)
- Schedule lighter tasks for post-lunch
- Leave buffer time for unexpected issues
- Consider the historical patterns when estimating durations

CRITICAL RULES:
- DO NOT combine multiple tasks into one schedule block
- Each task must get its own separate time block
- Use the EXACT task title as provided in the task list - do not shorten, summarize, or group tasks
- Example: If there are 3 "follow-up" tasks, create 3 separate blocks with their exact individual titles

Respond with a JSON object containing:
{
  "blocks": [
    {
      "start_time": "09:00",
      "end_time": "10:30",
      "type": "task",
      "title": "Task name",
      "description": "Brief description",
      "estimated_duration": 90
    },
    {
      "start_time": "10:30",
      "end_time": "10:40",
      "type": "break",
      "title": "Short break",
      "estimated_duration": 10
    },
    {
      "start_time": "12:00",
      "end_time": "12:30",
      "type": "lunch",
      "title": "Lunch break",
      "estimated_duration": 30
    }
  ],
  "suggestions": [
    "Tip about the schedule",
    "Another helpful suggestion"
  ]
}

CRITICAL: Use type "lunch" (not "break") for the 30-minute lunch break around midday.
IMPORTANT: Return ONLY valid JSON, no explanatory text before or after.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  const content = message.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  // Parse the JSON response
  const jsonMatch = content.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse schedule from Claude response');
  }

  const result = JSON.parse(jsonMatch[0]);
  return result;
}

export async function parseTasksFromNaturalLanguage(
  input: string
): Promise<Array<{
  title: string;
  description?: string;
  estimated_duration?: number;
  priority: 'high' | 'medium' | 'low';
  tags: string[];
}>> {
  const prompt = `Parse the following task input into structured task objects.

INPUT:
${input}

CRITICAL: Keep the EXACT original wording for task titles. Do NOT shorten, summarize, or rewrite them.

Extract individual tasks and for each one, determine:
- title: Use the EXACT original task name/description as written - DO NOT CHANGE THE WORDING
- description: Any additional context if separate from the title (optional)
- estimated_duration: Time in minutes (if mentioned like "30 minutes", "2 hours", or inferable)
- priority: high, medium, or low (based on labels like "Priority", "Mid Tier", "Low Tier", "urgent", "ASAP", etc.)
- tags: Relevant keywords/categories

Respond with JSON array only:
[
  {
    "title": "Exact original task wording here",
    "description": "Additional details if any",
    "estimated_duration": 60,
    "priority": "high",
    "tags": ["category1", "category2"]
  }
]

Return ONLY the JSON array, no other text.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000, // Increased for large task lists
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  const content = message.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  // Try to extract JSON array from response
  const jsonMatch = content.text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error('Claude response:', content.text);
    throw new Error('Could not parse tasks from Claude response');
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (parseError) {
    console.error('JSON parse error:', parseError);
    console.error('Attempted to parse:', jsonMatch[0].substring(0, 500));
    
    // Try to fix common JSON issues
    let fixedJson = jsonMatch[0]
      .replace(/,\s*]/g, ']')  // Remove trailing commas
      .replace(/,\s*}/g, '}'); // Remove trailing commas in objects
    
    try {
      return JSON.parse(fixedJson);
    } catch (secondError) {
      throw new Error('Failed to parse tasks JSON even after fixes. Try with fewer tasks.');
    }
  }
}

export function extractKeywordsFromTask(title: string, description?: string): string[] {
  const text = `${title} ${description || ''}`.toLowerCase();
  const commonWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
  
  const words = text
    .split(/\s+/)
    .map(w => w.replace(/[^\w]/g, ''))
    .filter(w => w.length > 3 && !commonWords.has(w));
  
  return [...new Set(words)].slice(0, 5);
}
