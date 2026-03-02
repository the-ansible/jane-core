import { useState } from 'react';
import { apiUrl } from '@/lib/utils';
import { Send } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

export function TestSender() {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [lastResult, setLastResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function send() {
    if (!message.trim() || sending) return;
    setSending(true);
    setLastResult(null);
    try {
      const res = await fetch(apiUrl('/api/test/inbound'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setLastResult({ ok: true, text: `Sent (${data.eventId?.slice(0, 12)}...)` });
        setMessage('');
      } else {
        setLastResult({ ok: false, text: data.error || 'Failed' });
      }
    } catch (e) {
      setLastResult({ ok: false, text: 'Network error' });
    }
    setSending(false);
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Test Message</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="Send a test inbound message..."
            className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
          <button
            onClick={send}
            disabled={!message.trim() || sending}
            className="flex items-center gap-1.5 rounded-md bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/25 disabled:opacity-40"
          >
            <Send className="h-3 w-3" />
            Send
          </button>
        </div>
        {lastResult && (
          <div className={`mt-1.5 text-[11px] ${lastResult.ok ? 'text-primary' : 'text-destructive'}`}>
            {lastResult.text}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
