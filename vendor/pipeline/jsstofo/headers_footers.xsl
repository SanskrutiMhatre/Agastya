<?xml version="1.0" encoding="UTF-8"?>
<!-- ********************************************************************
     JSS to XSL-FO: Headers and Footers

     Running head  : "Book Name / System Name" stacked, right aligned, rule below.
     Running foot  : rule above, "Page | folio" on the outer edge of the page.
     Classification: red bold underlined banner, centered (cover pages only).
     ******************************************************************** -->
<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0"
  xmlns:fo="http://www.w3.org/1999/XSL/Format">

    <!--
      Classification banner, top and bottom of the cover pages.

      Every property comes from Settings (see jsstofo.xsl for the parameters
      and their defaults, which reproduce the previous hardcoded red bold
      underline exactly). Size falls back to the running head/foot size when
      not set, so the banner matches the rest of the furniture by default but
      can be made larger on its own.
    -->
    <xsl:template name="classification-banner">
        <xsl:param name="color" select="$classification.color"/>
        <fo:block text-align="{$classification.align}"
                  font-weight="{$classification.weight}"
                  color="{$color}"
                  text-decoration="{$classification.decoration}"
                  padding-top="{$classification.padding.top}"
                  padding-bottom="{$classification.padding.bottom}"
                  padding-left="{$classification.padding.left}"
                  padding-right="{$classification.padding.right}">
            <xsl:attribute name="font-size">
                <xsl:choose>
                    <xsl:when test="normalize-space($classification.size) != ''">
                        <xsl:value-of select="$classification.size"/>
                    </xsl:when>
                    <xsl:otherwise><xsl:value-of select="$header-footer-size"/></xsl:otherwise>
                </xsl:choose>
            </xsl:attribute>
            <xsl:value-of select="$classification"/>
        </fo:block>
    </xsl:template>

    <!--
      Two-line running head with a rule beneath it: book name over system name.

      Both lines share one alignment and it follows the page, so the block sits
      against the OUTER edge of the spread — flush right on a recto, flush left
      on a verso. Fixed at right it hung off the inner edge on every left-hand
      page, which reads as a mistake in a double-sided book.

      Same $align convention as running-foot below, so head and foot are driven
      the same way from the page masters.
    -->
    <!--
      Margin notes: sideways text down the OUTER edge of every page.

      Emitted from the running foot's static-content with
      absolute-position="fixed", which escapes the region it is declared in, so
      no page master needs a side region and it still repeats on every page.
      Anchored by top/left because FOP renders that and silently drops a
      container anchored by bottom/right. width is the LONG side with the box
      then turned, since sized the other way round the text wraps after every
      word and runs down the page one word per line.

      Identical parameters to the S1000D engine, so one Settings tab drives
      both and a project that changes engine looks the same.
    -->
    <xsl:template name="jss-length-number">
        <xsl:param name="v"/>
        <xsl:value-of select="number(translate($v, translate($v, '0123456789.', ''), ''))"/>
    </xsl:template>

    <!--
      $page-w defaults to $page-width, right for the ordinary page sequence.
      A landscape page's rendered width is $page-height's value instead — the
      two are swapped on the simple-page-master, and $page-width is one fixed
      number for the whole stylesheet regardless of which master is in play.
      Left unparameterised, the outer-margin line anchored 87mm further right
      than a landscape page actually is (297mm assumed against a 210mm page),
      putting it off the trimmed edge entirely. See the identical note in the
      S1000D engine's own headers_footers.xsl — this is the same mechanism,
      ported.
    -->
    <xsl:template name="side-note-line">
        <xsl:param name="text"/>
        <xsl:param name="top"/>
        <xsl:param name="side">right</xsl:param>
        <xsl:param name="page-w" select="$page-width"/>
        <xsl:if test="normalize-space($text) != ''">
            <xsl:variable name="pw">
                <xsl:call-template name="jss-length-number"><xsl:with-param name="v" select="$page-w"/></xsl:call-template>
            </xsl:variable>
            <xsl:variable name="unit" select="translate($page-w, '0123456789.', '')"/>
            <xsl:variable name="gap">
                <xsl:call-template name="jss-length-number"><xsl:with-param name="v" select="$side.note.margin"/></xsl:call-template>
            </xsl:variable>
            <xsl:variable name="x">
                <xsl:choose>
                    <xsl:when test="$side = 'left'"><xsl:value-of select="concat($gap, $unit)"/></xsl:when>
                    <xsl:otherwise><xsl:value-of select="concat($pw - $gap, $unit)"/></xsl:otherwise>
                </xsl:choose>
            </xsl:variable>
            <fo:block-container absolute-position="fixed" top="{$top}" left="{$x}"
                                width="{$side.note.length}" height="5mm"
                                reference-orientation="90">
                <fo:block font-size="{$side.note.font.size}" wrap-option="no-wrap">
                    <xsl:value-of select="$text"/>
                </fo:block>
            </fo:block-container>
        </xsl:if>
    </xsl:template>

    <xsl:template name="side-notes">
        <xsl:param name="side">right</xsl:param>
        <!-- Passed down from running-foot, which got it from body-page-sequence
             — the one place that already knows which orientation this page is.
             See the note on $page-w in side-note-line. -->
        <xsl:param name="page-h" select="$page-height"/>
        <xsl:param name="page-w" select="$page-width"/>
        <xsl:if test="$side.note.enabled = '1'">
            <xsl:call-template name="side-note-line">
                <xsl:with-param name="text" select="$side.note.text"/>
                <xsl:with-param name="top" select="$side.note.top"/>
                <xsl:with-param name="side" select="$side"/>
                <xsl:with-param name="page-w" select="$page-w"/>
            </xsl:call-template>
        </xsl:if>
        <xsl:if test="$produced.by.enabled = '1' and normalize-space($meta/producedBy) != ''">
            <!-- Placed so its FOOT clears the footer rule: the first character
                 sits at (top + length) and the text runs upward from there, so
                 it is the foot that has to stay out of the footer band.
                 $page-h, not $page-height: on a landscape page the two differ,
                 and computing this against the wrong one put the line's start
                 above where the page even begins — see the S1000D engine's
                 note on this for the exact mechanism. -->
            <xsl:variable name="ph">
                <xsl:call-template name="jss-length-number"><xsl:with-param name="v" select="$page-h"/></xsl:call-template>
            </xsl:variable>
            <xsl:variable name="hunit" select="translate($page-h, '0123456789.', '')"/>
            <xsl:variable name="mb">
                <xsl:call-template name="jss-length-number"><xsl:with-param name="v" select="$page-margin-bottom"/></xsl:call-template>
            </xsl:variable>
            <xsl:variable name="fe">
                <xsl:call-template name="jss-length-number"><xsl:with-param name="v" select="$region-after-extent"/></xsl:call-template>
            </xsl:variable>
            <xsl:variable name="len">
                <xsl:call-template name="jss-length-number"><xsl:with-param name="v" select="$side.note.length"/></xsl:call-template>
            </xsl:variable>
            <xsl:variable name="clr">
                <xsl:call-template name="jss-length-number"><xsl:with-param name="v" select="$side.note.clearance"/></xsl:call-template>
            </xsl:variable>
            <xsl:variable name="ptop">
                <xsl:choose>
                    <xsl:when test="normalize-space($produced.by.top) != ''">
                        <xsl:value-of select="$produced.by.top"/>
                    </xsl:when>
                    <xsl:otherwise><xsl:value-of select="concat($ph - $mb - $fe - $clr - $len, $hunit)"/></xsl:otherwise>
                </xsl:choose>
            </xsl:variable>
            <xsl:call-template name="side-note-line">
                <!-- The company name comes from the publication, not Settings,
                     so it cannot drift out of step with the document. -->
                <xsl:with-param name="text" select="concat($produced.by.prefix, normalize-space($meta/producedBy))"/>
                <xsl:with-param name="top" select="$ptop"/>
                <xsl:with-param name="side" select="$side"/>
                <xsl:with-param name="page-w" select="$page-w"/>
            </xsl:call-template>
        </xsl:if>
    </xsl:template>

    <!--
      The publication's logo, or nothing when the source carries none.

      $align is which edge of the TABLE this cell's own column sits at — the
      logo has to align to that, not just default to "start" (left), because
      running-head swaps which column the logo is in between recto and verso
      (see below: first column when the title goes right, last when it goes
      left). A logo landing in the last column with no alignment sits flush
      against its own LEFT edge, one column short of the page's true right
      margin — a gap barely visible on a portrait page's narrow column, wide
      and obvious on a landscape page's much wider one.
    -->
    <xsl:template name="header-logo-cell">
        <xsl:param name="align">start</xsl:param>
        <xsl:variable name="logo" select="$meta/headerLogo/graphic/@src"/>
        <fo:table-cell display-align="center" text-align="{$align}">
            <fo:block>
                <xsl:if test="$logo != '' and normalize-space($header.logo.height) != ''">
                    <fo:external-graphic src="url('{$logo}')"
                        content-height="{$header.logo.height}"
                        content-width="scale-down-to-fit"
                        scaling="uniform"/>
                </xsl:if>
            </fo:block>
        </fo:table-cell>
    </xsl:template>

    <xsl:template name="header-title-cell">
        <xsl:param name="align"/>
        <fo:table-cell text-align="{$align}" display-align="center">
            <fo:block><xsl:value-of select="$book.name"/></fo:block>
            <fo:block><xsl:value-of select="$system.name"/></fo:block>
        </fo:table-cell>
    </xsl:template>

    <!--
      Running head: the book and system names, with the publication's logo
      opposite them when the source carries one.

      A two-cell table rather than an inline, because the names are two stacked
      lines and the logo has to sit beside the PAIR rather than inside the
      first of them. The logo takes the side the names do not, and the whole
      row mirrors on a verso, so the names always fall on the outer edge.

      The logo arrives as bookmeta/headerLogo/graphic, put there by
      s1000dtojss from pmStatus/logo (or the first module's dmStatus/logo). It
      is a <graphic> so the build's dimension-annotation pass repairs its path
      the way it does every other image — which is what makes a logo supplied
      as .svg work when the stylesheet's guess would have said .png.
    -->
    <!--
      The classification, centred, for the running head and foot — the same
      band classification-banner draws on the cover pages, but reused rather
      than duplicated: same $classification.* settings, so a house that sets
      its own colour or weight gets it in both places without a second set of
      parameters to find.

      Unlike the S1000D engine, this needs no marker/retrieve-marker pair.
      There, classification can differ data module to data module, so a value
      set at the top of one has to be carried forward page by page within
      that module's own page-sequence. Here $classification is one value for
      the whole book, resolved once, so a plain reference reads correctly on
      every page without anything to retrieve.
    -->
    <xsl:template name="classification-cell">
        <xsl:param name="color" select="$classification.color"/>
        <!-- $show.release: the running head passes '1' so its own release
             line renders centred under the classification, in the same
             column, matching the direct S1000D pipeline. The cover/prelim
             callers don't pass it, so nothing changes there. -->
        <xsl:param name="show.release">0</xsl:param>
        <fo:table-cell display-align="center">
            <xsl:call-template name="classification-banner">
                <xsl:with-param name="color" select="$color"/>
            </xsl:call-template>
            <xsl:if test="$show.release = '1' and normalize-space($release.label) != ''">
                <fo:block text-align="{$classification.align}" font-weight="bold">
                    <xsl:value-of select="$release.label"/>
                </fo:block>
            </xsl:if>
        </fo:table-cell>
    </xsl:template>

    <xsl:template name="running-head">
        <xsl:param name="align">right</xsl:param>
        <!--
          Black on chapter pages, red only on the cover: body-page-sequence
          passes 'black' here so a chapter's RESTRICTED reads as running
          furniture rather than the document's actual classification stamp,
          which stays wherever $classification.color says everywhere else
          (cover, prelims).
        -->
        <xsl:param name="classification-color" select="$classification.color"/>
        <fo:block font-size="{$header-footer-size}"
                  line-height="1.15"
                  border-bottom="0.8pt solid black"
                  padding-bottom="1.5mm">
            <!--
              Three equal columns always, logo cell included even when there
              is none to show: header-logo-cell already renders empty in that
              case (see its own xsl:if), and a fixed three-column table is
              what keeps the classification in the SAME centred column on
              every page, logo or none, recto or verso — a table that
              sometimes has two columns and sometimes three would shift it
              sideways depending on what else the page happened to have.
            -->
            <fo:table width="100%" table-layout="fixed">
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-body>
                    <fo:table-row>
                        <xsl:choose>
                            <!-- Recto: names right, so the logo goes left. -->
                            <xsl:when test="$align = 'right'">
                                <xsl:call-template name="header-logo-cell"/>
                                <xsl:call-template name="classification-cell">
                                    <xsl:with-param name="color" select="$classification-color"/>
                                    <xsl:with-param name="show.release">1</xsl:with-param>
                                </xsl:call-template>
                                <xsl:call-template name="header-title-cell">
                                    <xsl:with-param name="align" select="$align"/>
                                </xsl:call-template>
                            </xsl:when>
                            <xsl:otherwise>
                                <xsl:call-template name="header-title-cell">
                                    <xsl:with-param name="align" select="$align"/>
                                </xsl:call-template>
                                <xsl:call-template name="classification-cell">
                                    <xsl:with-param name="color" select="$classification-color"/>
                                    <xsl:with-param name="show.release">1</xsl:with-param>
                                </xsl:call-template>
                                <xsl:call-template name="header-logo-cell">
                                    <xsl:with-param name="align">end</xsl:with-param>
                                </xsl:call-template>
                            </xsl:otherwise>
                        </xsl:choose>
                    </fo:table-row>
                </fo:table-body>
            </fo:table>
        </fo:block>
    </xsl:template>

    <!--
      Running foot. When $chapter-number is supplied the folio is rendered
      chapter-relative ("3-8"); otherwise the page-sequence's own format
      (roman for prelims) is used.
    -->
    <xsl:template name="running-foot">
        <xsl:param name="align">right</xsl:param>
        <xsl:param name="chapter-number"/>
        <xsl:param name="page-h" select="$page-height"/>
        <xsl:param name="page-w" select="$page-width"/>
        <!-- Black on chapter pages, red only on the cover: see running-head. -->
        <xsl:param name="classification-color" select="$classification.color"/>
        <!-- $align is 'right' on a recto and 'left' on a verso, which is also
             which edge is the OUTER one, so the notes follow it.

             Suppressed entirely on a landscape page (page-h/page-w differing
             from the portrait defaults) rather than repositioned: matches the
             direct S1000D pipeline's own fix for the same overlap. -->
        <xsl:if test="$page-h = $page-height and $page-w = $page-width">
            <xsl:call-template name="side-notes">
                <xsl:with-param name="side" select="$align"/>
                <xsl:with-param name="page-h" select="$page-h"/>
                <xsl:with-param name="page-w" select="$page-w"/>
            </xsl:call-template>
        </xsl:if>
        <fo:block font-size="{$header-footer-size}"
                  border-top="0.8pt solid black"
                  padding-top="1.5mm">
            <!--
              Three equal columns, same reasoning as running-head: fixed
              regardless of $align, so the classification sits in the same
              centred column on every page rather than drifting sideways
              between a two-column recto and a two-column verso.
            -->
            <fo:table width="100%" table-layout="fixed">
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-body>
                    <fo:table-row>
                        <xsl:variable name="folio">
                            <fo:table-cell display-align="center" text-align="{$align}">
                                <fo:block>
                                    <xsl:text>Page | </xsl:text>
                                    <xsl:if test="$chapter-number != ''">
                                        <xsl:value-of select="$chapter-number"/>
                                        <xsl:text>-</xsl:text>
                                    </xsl:if>
                                    <fo:page-number/>
                                </fo:block>
                            </fo:table-cell>
                        </xsl:variable>
                        <xsl:variable name="doc-code">
                            <fo:table-cell display-align="center">
                                <fo:block><xsl:value-of select="$meta/ltDocumentNo"/></fo:block>
                            </fo:table-cell>
                        </xsl:variable>
                        <xsl:choose>
                            <!-- Recto: folio on the outer (right) edge, the document number on the inner (left). -->
                            <xsl:when test="$align = 'right'">
                                <xsl:copy-of select="$doc-code"/>
                                <xsl:call-template name="classification-cell">
                                    <xsl:with-param name="color" select="$classification-color"/>
                                </xsl:call-template>
                                <xsl:copy-of select="$folio"/>
                            </xsl:when>
                            <xsl:otherwise>
                                <xsl:copy-of select="$folio"/>
                                <xsl:call-template name="classification-cell">
                                    <xsl:with-param name="color" select="$classification-color"/>
                                </xsl:call-template>
                                <xsl:copy-of select="$doc-code"/>
                            </xsl:otherwise>
                        </xsl:choose>
                    </fo:table-row>
                </fo:table-body>
            </fo:table>
        </fo:block>
    </xsl:template>

</xsl:stylesheet>
