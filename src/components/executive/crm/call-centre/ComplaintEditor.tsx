import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Italic, List, ListOrdered, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRecordCallComplaint } from '@/hooks/useCalleeDossier';

/** Rich-text complaint recorder. Saved through `crm_record_call_complaint`. */
export function ComplaintEditor({ userId, callId }: { userId: string; callId: string | null }) {
  const save = useRecordCallComplaint(userId);
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false })],
    editorProps: {
      attributes: { class: 'prose prose-sm max-w-none min-h-[120px] px-3 py-2 focus:outline-none' },
    },
    content: '',
  });

  const tool = (active: boolean, onClick: () => void, label: string, Icon: typeof Bold) => (
    <Button type="button" size="icon" variant="ghost" aria-label={label} aria-pressed={active}
      className={cn('h-7 w-7', active && 'bg-muted')} onClick={onClick}>
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );

  const handleSave = async () => {
    if (!editor) return;
    const text = editor.getText().trim();
    if (text.length < 3) { toast.error('Write the complaint first.'); return; }
    try {
      await save.mutateAsync({ html: editor.getHTML(), text, callId });
      editor.commands.clearContent();
      toast.success('Complaint recorded.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record the complaint.');
    }
  };

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border bg-background">
        <div className="flex gap-0.5 border-b border-border p-1">
          {editor && tool(editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), 'Bold', Bold)}
          {editor && tool(editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), 'Italic', Italic)}
          {editor && tool(editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), 'Bullet list', List)}
          {editor && tool(editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), 'Numbered list', ListOrdered)}
        </div>
        <EditorContent editor={editor} />
      </div>
      <Button type="button" size="sm" className="w-full gap-2" onClick={handleSave} disabled={save.isPending}>
        <Save className="h-4 w-4" />{save.isPending ? 'Saving…' : 'Record complaint'}
      </Button>
    </div>
  );
}
