// html-to-image and jsPDF loaded dynamically to reduce initial bundle size
import { archivePdfBlob } from '@/lib/pdfVault';
import { supabase } from '@/integrations/supabase/client';

export interface ExportData {
  headers: string[];
  rows: (string | number)[][];
}

// Shared choke point for the ~20 components that call exportToCSV/exportToPDF
// with data spanning many users/transactions/records at once -- a real bulk
// data-exfiltration risk distinct from a single receipt download. Logging it
// once here, instead of at each call site. Plain client-side insert so the
// audit_logs IP-capture trigger sees the real browser IP directly. Never
// blocks the actual export.
async function logExport(actionType: 'csv_exported' | 'pdf_exported', filename: string, rowCount?: number) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('audit_logs').insert({
      user_id: user?.id ?? null,
      action_type: actionType,
      table_name: 'export',
      record_id: null,
      metadata: { filename, row_count: rowCount ?? null },
    });
  } catch (e) {
    console.warn('[exportUtils] audit log insert failed:', e);
  }
}

/**
 * Export data to CSV and trigger download
 */
export function exportToCSV(data: ExportData, filename: string): void {
  const { headers, rows } = data;
  
  // Escape CSV values
  const escapeCSV = (value: string | number): string => {
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  // Build CSV content
  const csvContent = [
    headers.map(escapeCSV).join(','),
    ...rows.map(row => row.map(escapeCSV).join(','))
  ].join('\n');

  // Create blob and download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}_${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  void logExport('csv_exported', filename, rows.length);
}

/**
 * Export an HTML element to PDF - optimized for mobile compatibility
 */
export async function exportToPDF(
  element: HTMLElement, 
  filename: string,
  title?: string
): Promise<void> {
  try {
    const { toPng } = await import('html-to-image');
    // Capture element as image with lower pixel ratio for better mobile compatibility
    const dataUrl = await toPng(element, {
      quality: 0.95,
      pixelRatio: 1.5, // Reduced for smaller file size and better mobile compatibility
      backgroundColor: '#ffffff',
      cacheBust: true,
      skipFonts: true, // Skip custom fonts for better compatibility
    });

    const { jsPDF } = await import('jspdf');
    // Create PDF with PDF/A-1b compatible settings for maximum compatibility
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true, // Enable compression for smaller file size
    });

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 10;

    // Add title if provided
    let yPosition = margin;
    if (title) {
      pdf.setFontSize(16);
      pdf.setFont('helvetica', 'bold');
      pdf.text(title, margin, yPosition + 8);
      yPosition += 15;
    }

    // Add date
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 100, 100);
    pdf.text(`Generated: ${new Date().toLocaleDateString()}`, margin, yPosition);
    yPosition += 8;

    // Calculate image dimensions to fit page
    const img = new Image();
    img.src = dataUrl;
    
    await new Promise<void>((resolve, reject) => {
      img.onload = () => {
        try {
          const imgWidth = pageWidth - (margin * 2);
          const imgHeight = (img.height * imgWidth) / img.width;
          
          // Handle multi-page if content is too tall
          const availableHeight = pageHeight - yPosition - margin;
          
          if (imgHeight <= availableHeight) {
            // Single page - content fits
            pdf.addImage(dataUrl, 'PNG', margin, yPosition, imgWidth, imgHeight, undefined, 'FAST');
          } else {
            // Scale to fit with proper aspect ratio
            const scale = availableHeight / imgHeight;
            const scaledWidth = imgWidth * scale;
            const scaledHeight = imgHeight * scale;
            const xOffset = margin + (imgWidth - scaledWidth) / 2;
            
            pdf.addImage(dataUrl, 'PNG', xOffset, yPosition, scaledWidth, scaledHeight, undefined, 'FAST');
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('Failed to load image'));
    });

    // Generate PDF as blob first, then create a more compatible download
    const pdfBlob = pdf.output('blob');

    // Archive a copy in the offline PDF vault so the record survives
    // network loss, browser cache wipes, or a cleared Downloads folder.
    archivePdfBlob(pdfBlob, {
      label: title || filename,
      filename: `${filename}_${new Date().toISOString().split('T')[0]}.pdf`,
      category: 'other',
    }).catch(() => {});
    
    // Create download link with better mobile support
    const blobUrl = URL.createObjectURL(pdfBlob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `${filename}_${new Date().toISOString().split('T')[0]}.pdf`;
    link.style.display = 'none';
    
    // For iOS Safari compatibility
    if (typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
      // Open in new tab for iOS devices
      window.open(blobUrl, '_blank');
    } else {
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
    
    // Clean up blob URL after a delay
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
    }, 1000);

    void logExport('pdf_exported', filename);
  } catch (error) {
    console.error('PDF export failed:', error);
    throw error;
  }
}

/**
 * Format number for export
 */
export function formatNumberForExport(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Format date for export
 */
export function formatDateForExport(date: string | Date): string {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}
