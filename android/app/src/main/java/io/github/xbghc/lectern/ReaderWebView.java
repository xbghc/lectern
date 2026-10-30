package io.github.xbghc.lectern;

import android.content.Context;
import android.util.AttributeSet;
import android.webkit.WebView;

/** Keep WebView's native selection toolbar (copy, select all, share, etc.). */
public class ReaderWebView extends WebView {
    public ReaderWebView(Context context) {
        this(context, null);
    }

    public ReaderWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        // The full-screen view must not draw a page-sized native focus highlight.
        // Individual HTML controls retain their accessible CSS focus rings.
        setDefaultFocusHighlightEnabled(false);
    }
}
