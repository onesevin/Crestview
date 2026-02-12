'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        router.push('/dashboard');
      } else {
        router.push('/login');
      }
    });
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#050507]">
      <div className="text-center animate-fade-in">
        <div className="inline-block mb-6">
          <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin-slow" />
        </div>
        <h1 className="text-3xl font-bold bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent mb-2">
          TaskFlow
        </h1>
        <p className="text-slate-400 text-sm">Loading...</p>
      </div>
    </div>
  );
}
