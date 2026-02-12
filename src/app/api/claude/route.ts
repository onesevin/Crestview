// src/app/api/claude/route.ts

import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.NEXT_PUBLIC_ANTHROPIC_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: { message: 'ANTHROPIC_API_KEY is not configured' } },
        { status: 500 }
      );
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(data);

  } catch (error) {
    console.error('Claude API error:', error);
    return NextResponse.json(
      { error: { message: 'Failed to call Claude API' } },
      { status: 500 }
    );
  }
}
