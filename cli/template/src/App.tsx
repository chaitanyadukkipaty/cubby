import { useEffect, useState, type FormEvent } from 'react';
import type { RecordModel } from 'pocketbase';
import { pb, col } from './lib/pb';

type Task = RecordModel & { title: string; done: boolean; owner: string };

export default function App() {
  const [user, setUser] = useState(pb.authStore.record);
  useEffect(() => pb.authStore.onChange((_, record) => setUser(record)), []);
  return (
    <main className="min-h-screen bg-stone-50 text-stone-900">
      <div className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">{{SLUG}}</h1>
        <p className="mt-1 text-stone-500">Built with Cubby — React, Tailwind and PocketBase.</p>
        <div className="mt-8">{user ? <Tasks /> : <AuthForm />}</div>
      </div>
    </main>
  );
}

function AuthForm() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [error, setError] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get('email'));
    const password = String(form.get('password'));
    setError('');
    try {
      if (mode === 'signup') await pb.collection(col('users')).create({ email, password, passwordConfirm: password });
      await pb.collection(col('users')).authWithPassword(email, password);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
      <input name="email" type="email" required placeholder="Email" aria-label="Email" className="w-full rounded-lg border border-stone-300 px-3 py-2" />
      <input name="password" type="password" required minLength={8} placeholder="Password" aria-label="Password" className="w-full rounded-lg border border-stone-300 px-3 py-2" />
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button className="w-full rounded-lg bg-stone-900 py-2 font-medium text-white hover:bg-stone-700">
        {mode === 'login' ? 'Log in' : 'Create account'}
      </button>
      <button type="button" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')} className="w-full text-sm text-stone-500 hover:text-stone-900">
        {mode === 'login' ? 'Need an account? Sign up' : 'Have an account? Log in'}
      </button>
    </form>
  );
}

function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const tasksCol = pb.collection(col('tasks'));

  useEffect(() => {
    const load = () => tasksCol.getFullList<Task>({ sort: '-created' }).then(setTasks);
    load();
    // Realtime keeps other tabs and devices in sync; this tab updates from each write's response.
    const unsub = tasksCol.subscribe('*', load);
    return () => { unsub.then((fn) => fn()); };
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const created = await tasksCol.create<Task>({ title, done: false, owner: pb.authStore.record!.id });
    setTasks((ts) => (ts.some((t) => t.id === created.id) ? ts : [created, ...ts]));
    setTitle('');
  }

  async function toggle(task: Task) {
    const updated = await tasksCol.update<Task>(task.id, { done: !task.done });
    setTasks((ts) => ts.map((t) => (t.id === updated.id ? updated : t)));
  }

  async function remove(task: Task) {
    await tasksCol.delete(task.id);
    setTasks((ts) => ts.filter((t) => t.id !== task.id));
  }

  return (
    <div className="space-y-4">
      <form onSubmit={add} className="flex gap-2">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" aria-label="New task" className="flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2" />
        <button className="rounded-lg bg-stone-900 px-4 font-medium text-white hover:bg-stone-700">Add</button>
      </form>
      <ul aria-label="Tasks" className="divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-center gap-3 px-4 py-3">
            <input type="checkbox" aria-label={`Done: ${t.title}`} checked={t.done} onChange={() => toggle(t)} className="size-4" />
            <span className={`flex-1 ${t.done ? 'text-stone-400 line-through' : ''}`}>{t.title}</span>
            <button onClick={() => remove(t)} aria-label={`Delete ${t.title}`} className="text-sm text-stone-400 hover:text-red-600">Delete</button>
          </li>
        ))}
        {!tasks.length && <li className="px-4 py-6 text-center text-stone-400">No tasks yet</li>}
      </ul>
      <button onClick={() => pb.authStore.clear()} className="text-sm text-stone-500 hover:text-stone-900">Log out</button>
    </div>
  );
}
