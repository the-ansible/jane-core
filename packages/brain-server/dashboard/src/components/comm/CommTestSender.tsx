import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { apiUrl } from '@/lib/utils';

export function CommTestSender() {
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<string | null>(null);

  async function handleSend() {
    if (!message.trim()) return;
    setResult(null);
    try {
      const res = await fetch(apiUrl('/api/communication/test/inbound'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (data.published) {
        setResult(`Sent (${data.eventId.slice(0, 12)}...)`);
        setMessage('');
      } else {
        setResult(`Error: ${data.error || 'unknown'}`);
      }
    } catch (err) {
      setResult(`Error: ${err}`);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Test Sender</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Send a test inbound message..."
            className="flex-1 rounded border border-border bg-muted px-2 py-1.5 text-sm text-card-foreground placeholder:text-muted-foreground outline-none focus:border-primary"
          />
          <button
            onClick={handleSend}
            disabled={!message.trim()}
            className="rounded border border-primary/50 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-40"
          >
            Send
          </button>
        </div>
        {result && <div className="mt-2 text-xs text-muted-foreground">{result}</div>}
      </CardContent>
    </Card>
  );
}
