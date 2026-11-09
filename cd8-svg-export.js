/* True-vector CD8 export; uses the same live GeoJSON as the on-screen map.
 * No raster map tiles, ward numbers, division labels, or text overlays are exported.
 */
(function () {
  'use strict';

  var COLOR_STOPS = [
    '#F9E175', // Bass 40+ points
    '#FBEBA5', // Bass 20-40
    '#FFF5D4', // Bass 5-20
    '#F9EBD8', // Within 5 points
    '#CEB4E1', // Seth 5-20
    '#8B5CB4', // Seth 20-40
    '#3F0E66'  // Seth 40+ points
  ];

  function exportColor(value) {
    if (value == null || !Number.isFinite(Number(value))) return '#E9E6E0';
    var m = Number(value);
    if (m < -40) return COLOR_STOPS[0];
    if (m < -20) return COLOR_STOPS[1];
    if (m < -5) return COLOR_STOPS[2];
    if (m < 5) return COLOR_STOPS[3];
    if (m < 20) return COLOR_STOPS[4];
    if (m < 40) return COLOR_STOPS[5];
    return COLOR_STOPS[6];
  }

  function ringsForGeometry(geometry) {
    if (!geometry || !geometry.coordinates) return [];
    if (geometry.type === 'Polygon') return [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates;
    return [];
  }

  // Web Mercator projection, so the vector export preserves map proportions.
  function mercator(lonLat) {
    var lon = Number(lonLat[0]) * Math.PI / 180;
    var lat = Math.max(-85.05112878, Math.min(85.05112878, Number(lonLat[1])));
    return [lon, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
  }

  function svgEscape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[char];
    });
  }

  function calculateCanvas(features) {
    var minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    features.forEach(function (feature) {
      ringsForGeometry(feature.geometry).forEach(function (polygon) {
        polygon.forEach(function (ring) {
          ring.forEach(function (point) {
            var p=mercator(point);
            minX=Math.min(minX,p[0]); maxX=Math.max(maxX,p[0]);
            minY=Math.min(minY,p[1]); maxY=Math.max(maxY,p[1]);
          });
        });
      });
    });
    if (![minX,minY,maxX,maxY].every(Number.isFinite)) {
      throw new Error('The selected CD8 boundary has no usable polygon geometry.');
    }
    var pad=28;
    var extent=Math.max(maxX-minX,maxY-minY);
    if (!extent) throw new Error('CD8 boundary geometry has no extent.');
    var scale=1600/extent;
    var width=Math.ceil((maxX-minX)*scale+2*pad);
    var height=Math.ceil((maxY-minY)*scale+2*pad);
    function project(point) {
      var p=mercator(point);
      return [(pad+(p[0]-minX)*scale).toFixed(2),(pad+(maxY-p[1])*scale).toFixed(2)];
    }
    return {width:width,height:height,project:project};
  }

  function polygonPath(geometry,project) {
    var pieces=[];
    ringsForGeometry(geometry).forEach(function (polygon) {
      polygon.forEach(function (ring) {
        if (!ring || ring.length<3) return;
        var coords=ring.map(project);
        pieces.push('M'+coords[0][0]+' '+coords[0][1]+' '+coords.slice(1).map(function (xy) {
          return 'L'+xy[0]+' '+xy[1];
        }).join('')+'Z');
      });
    });
    return pieces.join('');
  }

  function createCd8Svg() {
    if (!isCd8Mode() || dataLayer.value !== 'cd8_council_23p') {
      throw new Error('Select City Council 8 and the Seth vs. Bass 2023 Primary layer first.');
    }
    var precincts=(currentPrecincts && currentPrecincts.features) || [];
    var wards=(currentWards && currentWards.features) || [];
    var boundary=(currentBoundary && currentBoundary.features) || [];
    if (!precincts.length || !boundary.length) {
      throw new Error('Map boundaries have not finished loading. Try the export again.');
    }
    // The full district extent is exported, regardless of the current pan/zoom.
    var canvas=calculateCanvas(boundary);
    var project=canvas.project;
    var boundaryPaths=boundary.map(function (f) {
      return polygonPath(f.geometry,project);
    }).filter(Boolean);
    if (!boundaryPaths.length) throw new Error('CD8 has no polygon boundary to export.');

    var clipping=boundaryPaths.map(function (d) {
      return '<path d="'+d+'" clip-rule="evenodd"/>';
    }).join('\n');

    var divisions=precincts.map(function (feature) {
      var d=polygonPath(feature.geometry,project);
      if (!d) return '';
      var p=feature.properties || {};
      var margin=(p.cd8c23_margin_pp==null)?null:Number(p.cd8c23_margin_pp);
      var label=(p.display_id || p.division_code || '');
      var tooltip='Division '+String(label);
      if (margin!=null && Number.isFinite(margin)) {
        tooltip+=' - '+(margin>=0?'Seth':'Bass')+' +'+Math.abs(margin).toFixed(1)+' points';
      } else {
        tooltip+=' - No recorded result';
      }
      return '<path d="'+d+'" fill="'+exportColor(margin)+'" fill-rule="evenodd" stroke="#777777" stroke-opacity="0.52" stroke-width="0.9" stroke-linejoin="round" data-division="'+svgEscape(label)+'" data-margin-pp="'+svgEscape(margin == null ? '' : margin.toFixed(2))+'"><title>'+svgEscape(tooltip)+'</title></path>';
    }).filter(Boolean).join('\n');

    var wardPaths=wards.map(function (feature) {
      var d=polygonPath(feature.geometry,project);
      if (!d) return '';
      var p=feature.properties || {};
      return '<path d="'+d+'" fill="none" stroke="#000000" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round" data-ward="'+svgEscape(p.ward)+'"/>';
    }).filter(Boolean).join('\n');

    var districtPaths=boundaryPaths.map(function (d) {
      return '<path d="'+d+'" fill="none" stroke="#000000" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>';
    }).join('\n');

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="'+canvas.width+'" height="'+canvas.height+'" viewBox="0 0 '+canvas.width+' '+canvas.height+'" role="img" aria-label="Philadelphia City Council District 8, 2023 Democratic Primary, Seth Anderson-Oberman versus Cindy Bass">',
      '<title>CD8 — Seth Anderson-Oberman vs. Cindy Bass — 2023 Democratic Primary</title>',
      '<desc>Editable vector SVG. Purple denotes Seth and yellow denotes Bass; shades represent candidate vote-share margins. Transparent background. Black ward and council district boundary lines; no labels or basemap.</desc>',
      '<defs><clipPath id="cd8-clip">'+clipping+'</clipPath></defs>',
      '<g id="precinct-results" clip-path="url(#cd8-clip)">'+divisions+'</g>',
      '<g id="ward-boundaries" clip-path="url(#cd8-clip)">'+wardPaths+'</g>',
      '<g id="city-council-district-8-boundary">'+districtPaths+'</g>',
      '</svg>'
    ].join('\n');
  }

  function downloadCd8Svg() {
    var source=createCd8Svg();
    var blob=new Blob([source],{type:'image/svg+xml;charset=utf-8'});
    var href=URL.createObjectURL(blob);
    var anchor=document.createElement('a');
    anchor.href=href;
    anchor.download='CD8_2023_Seth_vs_Bass_vector.svg';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () { URL.revokeObjectURL(href); },2000);
  }

  function updateSvgExportButton() {
    var btn=document.getElementById('exportSvgBtn');
    if (!btn) return;
    btn.disabled=!(isCd8Mode() && dataLayer.value==='cd8_council_23p');
  }

  function exportSvgIfRequested() {
    updateSvgExportButton();
    if (new URLSearchParams(window.location.search).get('export')!=='svg') return;
    try {
      downloadCd8Svg();
      var status=document.getElementById('exportSvgStatus');
      if (status) status.textContent='Vector SVG generated.';
    } catch (err) {
      var statusEl=document.getElementById('exportSvgStatus');
      if (statusEl) statusEl.textContent=err.message;
      console.error('SVG export:',err);
    }
  }

  var exportBtn=document.getElementById('exportSvgBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click',function () {
      var status=document.getElementById('exportSvgStatus');
      try {
        downloadCd8Svg();
        if (status) status.textContent='Vector SVG generated.';
      } catch (err) {
        if (status) status.textContent=err.message;
        console.error('SVG export:',err);
      }
    });
  }
  if (typeof geoType !== 'undefined') geoType.addEventListener('change',updateSvgExportButton);
  if (typeof geoValue !== 'undefined') geoValue.addEventListener('change',updateSvgExportButton);
  if (typeof dataLayer !== 'undefined') dataLayer.addEventListener('change',updateSvgExportButton);
  window.exportSvgIfRequested=exportSvgIfRequested;
  window.updateSvgExportButton=updateSvgExportButton;
})();
