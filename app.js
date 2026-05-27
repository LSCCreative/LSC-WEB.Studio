document.addEventListener('DOMContentLoaded', () => {

    // --- Cinematic HUD Interactive Logic ---
    const focusMeter = document.getElementById('focusMeter');
    const waveform = document.querySelector('.audio-waveform');
    
    if (focusMeter) {
        let mouseX = window.innerWidth / 2;
        let mouseY = window.innerHeight / 2;
        let meterX = mouseX;
        let meterY = mouseY;
        
        window.addEventListener('mousemove', (e) => {
            mouseX = e.clientX;
            mouseY = e.clientY;
            
            // Audio Waveform Parallax Shift (Phase 11)
            if (waveform) {
                const shiftY = (window.innerHeight / 2 - mouseY) * 0.05;
                waveform.style.transform = `translateY(${shiftY}px)`;
            }
        });

        function animateMeter() {
            meterX += (mouseX - meterX) * 0.08;
            meterY += (mouseY - meterY) * 0.08;
            focusMeter.style.transform = `translate(${meterX}px, ${meterY}px) translate(-50%, -50%)`;
            requestAnimationFrame(animateMeter);
        }
        animateMeter();
    }

    // --- HUD Timecode Tracker ---
    const timecodeObj = document.getElementById('timecode');
    if (timecodeObj) {
        let frames = 12;
        let seconds = 24;
        let minutes = 0;
        setInterval(() => {
            frames++;
            if(frames >= 24) { frames = 0; seconds++; }
            if(seconds >= 60) { seconds = 0; minutes++; }
            const pad = (n) => n.toString().padStart(2, '0');
            timecodeObj.innerText = `T: 00:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
        }, 1000/24);
    }

    // --- Page-level scrolling and reveal effects ---
    const header = document.querySelector('.navbar');
    const scrollIndicator = document.querySelector('.scroll-indicator');
    const revealElements = document.querySelectorAll('.fade-in-up, .animate-entrance');

    const changeHeaderState = () => {
        if (!header) return;
        if (window.scrollY > 20) {
            header.classList.add('scrolled');
        } else {
            header.classList.remove('scrolled');
        }
    };

    const hideScrollIndicator = () => {
        if (!scrollIndicator) return;
        if (window.scrollY > 80) {
            scrollIndicator.style.opacity = '0';
            scrollIndicator.style.pointerEvents = 'none';
        }
    };

    const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                revealObserver.unobserve(entry.target);
            }
        });
    }, { threshold: 0.2 });

    revealElements.forEach(el => revealObserver.observe(el));

    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', (e) => {
            const targetId = anchor.getAttribute('href');
            if (targetId.length > 1 && document.querySelector(targetId)) {
                e.preventDefault();
                document.querySelector(targetId).scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });

    changeHeaderState();
    hideScrollIndicator();
    window.addEventListener('scroll', () => {
        changeHeaderState();
        hideScrollIndicator();
    });

    // --- Horizontal Scroll & Hover Logic ---
    const scrollSection = document.querySelector('.horizontal-scroll-section');
    const gallery = document.getElementById('portfolioGallery');
    
    if (scrollSection && gallery) {
        window.addEventListener('scroll', () => {
            if (window.innerWidth <= 768) {
                gallery.style.transform = `none`;
                return; 
            }
            
            const sectionTop = scrollSection.offsetTop;
            const sectionHeight = scrollSection.offsetHeight;
            const windowHeight = window.innerHeight;
            
            // --- Phase 21: Hero Section Scroll Invert & Freeze ---
            const heroVideo = document.querySelector('.hero-fallback-bg');
            if (sectionTop > 0) {
                // Ratio tracking how far down the hero section we've scrolled
                const heroScrollRatio = Math.min(Math.max(window.scrollY / sectionTop, 0), 1);
                
                if (heroVideo) {
                    heroVideo.style.filter = `invert(${heroScrollRatio})`;
                    
                    // Lock the physical playback exactly at the math 50% threshold bound!
                    if (heroScrollRatio >= 0.5) {
                        if (!heroVideo.paused) heroVideo.pause();
                    } else {
                        if (heroVideo.paused) heroVideo.play().catch(()=>{});
                    }
                }
                
                // Typography Phase-In: Gallery intro actively fades up against the hero descent!
                const galleryIntro = gallery.querySelector('.gallery-intro');
                if (galleryIntro) {
                    galleryIntro.style.opacity = heroScrollRatio;
                }
            }
            
            let scrollProgress = window.scrollY - sectionTop;
            
            if (scrollProgress >= 0 && window.scrollY <= sectionTop + sectionHeight) {
                const percentage = Math.min(scrollProgress / (sectionHeight - windowHeight), 1);
                const maxTranslate = gallery.scrollWidth - window.innerWidth + 100;
                gallery.style.transform = `translate3d(-${percentage * maxTranslate}px, 0, 0)`;
                
                // --- Phase 14: Scroll Math Color Interpolation ---
                // Fades background from #181818 (rgb 24,24,24) to #F0EDE8 (rgb 240,237,232)
                const fadeProgress = Math.min(Math.max(scrollProgress / (windowHeight * 0.8), 0), 1);
                const r = Math.round(24 + (240 - 24) * fadeProgress);
                const g = Math.round(24 + (237 - 24) * fadeProgress);
                const b = Math.round(24 + (232 - 24) * fadeProgress);
                scrollSection.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;

                // --- Phase 23.5: Legibility Restoration ---
                // Fades Main Title natively from Warm White to Near Black (Opposite of Background)
                const tr = Math.round(240 + (24 - 240) * fadeProgress);
                const tg = Math.round(237 + (24 - 237) * fadeProgress);
                const tb = Math.round(232 + (24 - 232) * fadeProgress);
                const sectionTitle = gallery.querySelector('.section-title');
                if (sectionTitle) {
                    sectionTitle.style.color = `rgb(${tr}, ${tg}, ${tb})`;
                    sectionTitle.style.textShadow = 'none'; // Strips out the camouflage shadow
                }
                
                const subtitle = gallery.querySelector('.section-subtitle');
                if (subtitle) {
                    subtitle.style.color = `rgb(${tr}, ${tg}, ${tb})`;
                    subtitle.style.textShadow = 'none';
                }

                // --- Phase 24: Lateral Inversion Tracking ---
                // Fades Film Strip PNG from Negative mapped purely to lateral movement instead of vertical pinning
                const filmFade = Math.min(Math.max(percentage * 2.5, 0), 1); // Hits positive at 40% horizontal scroll
                const filmStrip = document.querySelector('.film-strip-layer');
                if (filmStrip) {
                    filmStrip.style.filter = `invert(${1 - filmFade})`;
                }
                
                // Phase 21: Propagate negative-to-positive filter across all gallery images
                const galleryImages = gallery.querySelectorAll('.playable-tile img');
                galleryImages.forEach(img => {
                    img.style.filter = `invert(${1 - filmFade})`;
                });
            }
        });
        
        // Dynamically force an instant scroll calculation upon page load to perfectly snap bounding opacities
        window.dispatchEvent(new Event('scroll'));

        // Interactive Playable Video Logic
        const tiles = document.querySelectorAll('.playable-tile');
        
        tiles.forEach(tile => {
            const video = tile.querySelector('video');
            const playBtn = tile.querySelector('.native-player-toggle');
            
            // Skip logic if no native video is present inside this tile
            if (!video || !playBtn) return;
            
            // Hover states (Only tracks playback logic, visual dimming removed)
            tile.addEventListener('mouseenter', () => {
                if(video.paused) {
                    video.loop = true;
                    video.muted = true;
                    video.play().catch(() => {});
                }
            });
            
            tile.addEventListener('mouseleave', () => {
                // Auto pause if it was just in silent hover state
                if(video.muted) {
                    video.pause();
                }
            });

            // Native Click to watch
            playBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                if(video.muted) {
                    // --- Phase 17: Exclusive Selection Engine ---
                    tiles.forEach(otherTile => {
                        if (otherTile !== tile && otherTile.classList.contains('is-watching')) {
                            const otherVid = otherTile.querySelector('video');
                            const otherBtn = otherTile.querySelector('.native-player-toggle');
                            if (otherVid && otherBtn) {
                                otherVid.pause();
                                otherVid.controls = false;
                                otherVid.muted = true;
                                otherBtn.style.opacity = '1';
                                otherBtn.style.pointerEvents = 'all';
                                otherTile.classList.remove('is-watching');
                                // Resurrect resting loop
                                otherVid.loop = true;
                                otherVid.play().catch(()=>{});
                            }
                        }
                    });

                    // Turn into full native watcher
                    video.muted = false;
                    video.controls = true;
                    video.currentTime = 0; // Restart for actual viewing
                    video.play().catch(() => {});
                    playBtn.style.opacity = '0'; // Hide the giant fake button
                    playBtn.style.pointerEvents = 'none';
                    tile.classList.add('is-watching');
                }
            });
            
            // Allow native controls to take over pause/play
            video.addEventListener('pause', () => {
                if(!video.muted) {
                    // If they specifically paused the native controls
                    video.controls = false;
                    video.muted = true;
                    playBtn.style.opacity = '1';
                    playBtn.style.pointerEvents = 'all';
                    tile.classList.remove('is-watching');
                }
            });
        });
    }

    // --- NEW: Interactive Video Grid Logic ---
    const gridItems = document.querySelectorAll('.grid-item');
    const gridBg = document.getElementById('gridBg');

    // Boot up global looping autoplay for all tiles
    gridItems.forEach(item => {
        const video = item.querySelector('video');
        if (video) {
            video.muted = true;
            video.loop = true;
            video.play().catch(() => {});
        }
        
        item.addEventListener('mouseenter', () => {
            // Pause all videos (including hovered) and hide siblings
            gridItems.forEach(sib => {
                const sibVid = sib.querySelector('video');
                if (sibVid) sibVid.pause(); // Freezes on current frame!
                if (sib !== item) {
                    sib.style.opacity = '0'; 
                }
            });
            
            if (gridBg && video) {
                gridBg.innerHTML = ''; 
                const clonedVid = video.cloneNode(true);
                clonedVid.className = ''; 
                clonedVid.style.position = 'absolute';
                clonedVid.style.top = '0';
                clonedVid.style.left = '0';
                clonedVid.style.width = '100%';
                clonedVid.style.height = '100%';
                clonedVid.style.objectFit = 'cover';
                clonedVid.style.zIndex = '1';
                clonedVid.muted = true;
                clonedVid.loop = true;
                clonedVid.currentTime = 0; // Start background boom from 0
                gridBg.appendChild(clonedVid);
                clonedVid.play().catch(()=>{});
                gridBg.style.opacity = 1; 
            }
        });

        item.addEventListener('mouseleave', () => {
            // Reactivate playback on all tiles instantly and fade them back up
            gridItems.forEach(sib => {
                sib.style.opacity = '1';
                const sibVid = sib.querySelector('video');
                if (sibVid) sibVid.play().catch(() => {});
            });

            if (gridBg) {
                gridBg.style.opacity = 0;
                setTimeout(() => { if (gridBg.style.opacity === '0') gridBg.innerHTML = ''; }, 600);
            }
        });
    });

    // --- About Popup Logic ---
    const aboutNavBtn = document.getElementById('aboutNavBtn');
    const aboutPopupOverlay = document.getElementById('aboutPopupOverlay');
    const closeAboutBtn = document.getElementById('closeAboutBtn');

    if (aboutNavBtn && aboutPopupOverlay && closeAboutBtn) {
        aboutNavBtn.addEventListener('click', (e) => {
            e.preventDefault(); // Prevent jump to #contact
            aboutPopupOverlay.classList.add('active');
        });

        closeAboutBtn.addEventListener('click', () => {
            aboutPopupOverlay.classList.remove('active');
        });

        // Close on click outside the box
        aboutPopupOverlay.addEventListener('click', (e) => {
            if (e.target === aboutPopupOverlay) {
                aboutPopupOverlay.classList.remove('active');
            }
        });
        
        // Escape key to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && aboutPopupOverlay.classList.contains('active')) {
                aboutPopupOverlay.classList.remove('active');
            }
        });
    }

    // --- Contact Popup Logic ---
    const contactNavBtn = document.getElementById('contactNavBtn');
    const contactPopupOverlay = document.getElementById('contactPopupOverlay');
    const closeContactBtn = document.getElementById('closeContactBtn');

    if (contactNavBtn && contactPopupOverlay && closeContactBtn) {
        contactNavBtn.addEventListener('click', (e) => {
            e.preventDefault(); 
            contactPopupOverlay.classList.add('active');
        });

        closeContactBtn.addEventListener('click', () => {
            contactPopupOverlay.classList.remove('active');
        });

        // Close on click outside the box
        contactPopupOverlay.addEventListener('click', (e) => {
            if (e.target === contactPopupOverlay) {
                contactPopupOverlay.classList.remove('active');
            }
        });
        
        // Escape key to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && contactPopupOverlay.classList.contains('active')) {
                contactPopupOverlay.classList.remove('active');
            }
        });
    }

});
